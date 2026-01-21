import puppeteer from "@cloudflare/puppeteer";

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
            // 设置 User-Agent 减少被检测的风险
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
            
            await page.goto(videoUrl, { waitUntil: "networkidle2" });

            // 1. 自动播放并隐藏干扰元素
            await page.evaluate(() => {
                const video = document.querySelector('video');
                if (video) video.play();
                const controls = document.querySelector('.ytp-chrome-bottom');
                if (controls) controls.style.display = 'none';
            });

            await new Promise(r => setTimeout(r, 6000));

            // 2. 绕过 Trusted Types：先抓取像素数据，再在 Worker 端处理（或者在浏览器内避开注入）
            // 我们通过 addScriptTag 注入一个可靠的 CDN 脚本，这通常能绕过部分策略
            // 如果 addScriptTag 也失效，我们改用手动注入 base64 版本的 jsQR
            await page.addScriptTag({ url: 'https://cdnjs.cloudflare.com/ajax/libs/jsQR/1.4.0/jsQR.min.js' });

            const nodeLink = await page.evaluate(() => {
                const video = document.querySelector('video');
                const canvas = document.createElement('canvas');
                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                
                const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
                // 此时 jsQR 已经在全局环境中可用了
                const code = window.jsQR(imageData.data, imageData.width, imageData.height);
                
                return code ? code.data : null;
            });

            if (!nodeLink) {
                await browser.close();
                return new Response(JSON.stringify({ error: "未发现二维码，请刷新页面重试" }), {
                    headers: { "Content-Type": "application/json" }
                });
            }

            // 3. 拼接订阅链接
            const encodedNode = encodeURIComponent(nodeLink);
            const clashSubUrl = `${subConverterBase}/sub?target=clash&url=${encodedNode}&insert=false&config=base&emoji=true&list=false&udp=true&tfo=false&scv=false&fdn=false&sort=false`;

            await browser.close();

            return new Response(JSON.stringify({
                status: "success",
                node: nodeLink,
                clash: clashSubUrl
            }), { headers: { "Content-Type": "application/json" } });

        } catch (e) {
            await browser.close();
            return new Response("处理失败: " + e.message, { status: 500 });
        }
    }
};
