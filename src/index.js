import puppeteer from "@cloudflare/puppeteer";
import jsQR from "jsqr";

export default {
  async fetch(request, env) {
    return await this.processVideo(env);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(this.processVideo(env));
  },

  async processVideo(env) {
    const videoUrl = "https://www.youtube.com/watch?v=V1nVrDSZmSE";
    const subConverterBase = "https://sb.leelaotou.us.kg";
    
    const browser = await puppeteer.launch(env.BROWSER);
    const page = await browser.newPage();

    try {
      // 1. 设置高清视口以提高识别率
      await page.setViewport({ width: 1920, height: 1080 });
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
      
      await page.goto(videoUrl, { waitUntil: "networkidle2" });

      // 2. 隐藏 UI 并确保播放
      await page.evaluate(() => {
        const video = document.querySelector('video');
        if (video) video.play();
        const controls = document.querySelector('.ytp-chrome-bottom');
        if (controls) controls.style.display = 'none';
      });

      // 给直播流留出足够的缓冲时间
      await new Promise(r => setTimeout(r, 8000));

      // 3. 获取截图数据
      // 我们直接截取视频所在的区域，或者全屏截图
      const screenshotBuffer = await page.screenshot({ type: "png" });

      // 4. 在 Worker 端获取像素数据并识别
      // 我们需要通过 browser 内部的 evaluate 提取像素，因为 Worker 本身处理图片二进制较慢
      const rgbaData = await page.evaluate(() => {
        const video = document.querySelector('video');
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        return {
          data: Array.from(imgData.data), // 转为普通数组传回 Worker
          width: imgData.width,
          height: imgData.height
        };
      });

      await browser.close();

      // 5. 使用 jsQR 识别（在 Worker 环境运行，不受 YouTube 限制）
      const code = jsQR(new Uint8ClampedArray(rgbaData.data), rgbaData.width, rgbaData.height);

      if (!code) {
        return new Response(JSON.stringify({ error: "未能识别二维码，请重试" }), {
          headers: { "Content-Type": "application/json" }
        });
      }

      // 6. 构造订阅链接
      const nodeLink = code.data;
      const encodedNode = encodeURIComponent(nodeLink);
      const clashSubUrl = `${subConverterBase}/sub?target=clash&url=${encodedNode}&insert=false&config=base&emoji=true&list=false&udp=true&tfo=false&scv=false&fdn=false&sort=false`;

      // 保存到 R2
      const fileName = `nodes/${new Date().getTime()}.txt`;
      await env.MY_BUCKET.put(fileName, `Node: ${nodeLink}\nClash: ${clashSubUrl}`);

      return new Response(JSON.stringify({
        status: "success",
        node: nodeLink,
        clash: clashSubUrl
      }), { headers: { "Content-Type": "application/json" } });

    } catch (e) {
      if (browser) await browser.close();
      return new Response("处理失败: " + e.message, { status: 500 });
    }
  }
};
