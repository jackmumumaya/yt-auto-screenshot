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
      await page.setViewport({ width: 1280, height: 720 });
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
      await page.goto(videoUrl, { waitUntil: "networkidle2" });

      await page.evaluate(() => {
        const video = document.querySelector('video');
        if (video) video.play();
        const controls = document.querySelector('.ytp-chrome-bottom');
        if (controls) controls.style.display = 'none';
      });

      await new Promise(r => setTimeout(r, 8000));

      // 提取像素数据
      const rgbaData = await page.evaluate(() => {
        const video = document.querySelector('video');
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        return {
          data: Array.from(imgData.data),
          width: imgData.width,
          height: imgData.height,
          screenshot: canvas.toDataURL('image/jpeg', 0.8) // 同时抓取一张截图用于 UI 显示
        };
      });

      await browser.close();

      const code = jsQR(new Uint8ClampedArray(rgbaData.data), rgbaData.width, rgbaData.height);

      if (!code) {
        return new Response("未能识别到二维码，视频画面可能尚未加载出节点，请刷新重试。", { status: 404 });
      }

      const nodeLink = code.data;
      const encodedNode = encodeURIComponent(nodeLink);

      // 生成各种客户端订阅链接
      const subLinks = {
        "Clash": `${subConverterBase}/sub?target=clash&url=${encodedNode}&insert=false&emoji=true&list=false&udp=true`,
        "V2Ray": `${subConverterBase}/sub?target=v2ray&url=${encodedNode}&insert=false&emoji=true&list=false&udp=true`,
        "Sing-box": `${subConverterBase}/sub?target=singbox&url=${encodedNode}&insert=false&emoji=true&list=false&udp=true`,
        "QuantumultX": `${subConverterBase}/sub?target=quanx&url=${encodedNode}&insert=false&emoji=true&list=false&udp=true`,
        "Surge": `${subConverterBase}/sub?target=surge&ver=4&url=${encodedNode}&insert=false&emoji=true&list=false&udp=true`
      };

      // 返回美化的 HTML 界面
      const html = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>YouTube 节点自动提取</title>
    <style>
        body { font-family: -apple-system, sans-serif; background: #f4f7f9; color: #333; padding: 20px; display: flex; flex-direction: column; align-items: center; }
        .card { background: white; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); padding: 20px; width: 100%; max-width: 500px; margin-bottom: 20px; }
        h2 { color: #ff0000; font-size: 1.2rem; margin-top: 0; }
        .screenshot { width: 100%; border-radius: 8px; margin-bottom: 15px; border: 1px solid #ddd; }
        .link-item { margin-bottom: 12px; }
        label { display: block; font-size: 0.85rem; font-weight: bold; margin-bottom: 5px; color: #666; }
        .input-group { display: flex; gap: 8px; }
        input { flex: 1; padding: 8px; border: 1px solid #ddd; border-radius: 4px; font-size: 0.8rem; background: #f9f9f9; }
        button { padding: 8px 15px; background: #007bff; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 0.8rem; transition: background 0.2s; }
        button:hover { background: #0056b3; }
        .footer { font-size: 0.75rem; color: #999; text-align: center; }
    </style>
</head>
<body>
    <div class="card">
        <h2>🎥 当前视频画面</h2>
        <img src="${rgbaData.screenshot}" class="screenshot" alt="视频截图">
        <label>原始节点链接 (推荐直接导入)</label>
        <div class="input-group">
            <input type="text" value="${nodeLink}" readonly id="rawNode">
            <button onclick="copyToClipboard('rawNode')">复制</button>
        </div>
    </div>

    <div class="card">
      <h2>🔗 订阅转换链接</h2>
      ${Object.entries(subLinks).map(([name, link]) => `
        <div class="link-item">
            <label>${name}</label>
            <div class="input-group">
                <input type="text" value="${link}" readonly id="sub_${name}">
                <button onclick="copyToClipboard('sub_${name}')">复制</button>
            </div>
        </div>
      `).join('')}
    </div>

    <div class="footer">由 Cloudflare Worker + Puppeteer 自动生成</div>

    <script>
        function copyToClipboard(id) {
            const copyText = document.getElementById(id);
            copyText.select();
            copyText.setSelectionRange(0, 99999);
            navigator.clipboard.writeText(copyText.value);
            const btn = event.target;
            const originalText = btn.innerText;
            btn.innerText = '已复制';
            btn.style.background = '#28a745';
            setTimeout(() => {
                btn.innerText = originalText;
                btn.style.background = '#007bff';
            }, 2000);
        }
    </script>
</body>
</html>
      `;

      return new Response(html, {
        headers: { "Content-Type": "text/html;charset=UTF-8" }
      });

    } catch (e) {
      if (browser) await browser.close();
      return new Response("系统繁忙: " + e.message, { status: 500 });
    }
  }
};
