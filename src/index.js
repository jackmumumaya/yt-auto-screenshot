import puppeteer from "@cloudflare/puppeteer";

export default {
  // 1. 处理手动访问 (浏览器打开 URL)
  async fetch(request, env) {
    return await this.takeScreenshot(env);
  },

  // 2. 处理定时任务 (Cron Trigger)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(this.takeScreenshot(env));
  },

  // 核心截图逻辑
  async takeScreenshot(env) {
    const url = "https://www.youtube.com/watch?v=V1nVrDSZmSE";
    const browser = await puppeteer.launch(env.BROWSER);
    const page = await browser.newPage();

    try {
      await page.setViewport({ width: 1280, height: 720 });
      
      // 访问 YouTube 并等待网络空闲
      await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });

      // 简单处理：隐藏弹窗并播放视频
      await page.evaluate(() => {
        const video = document.querySelector('video');
        if (video) video.play();
        // 隐藏 YouTube 控制栏以防遮挡二维码
        const controls = document.querySelector('.ytp-chrome-bottom');
        if (controls) controls.style.display = 'none';
      });

      // 等待 5 秒确保直播加载出画面
      await new Promise(r => setTimeout(r, 5000));

      const screenshot = await page.screenshot({ type: "png" });

      // 将截图保存到 R2 存储桶，文件名带上时间戳
      const fileName = `screenshot-${new Date().toISOString()}.png`;
      await env.MY_BUCKET.put(fileName, screenshot, {
        httpMetadata: { contentType: "image/png" }
      });

      await browser.close();
      return new Response(`成功截取并保存至 R2: ${fileName}`, { status: 200 });

    } catch (e) {
      await browser.close();
      return new Response(`错误: ${e.message}`, { status: 500 });
    }
  }
};
