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
        const subConverterBase = "https://sb.leelaotou.us.kg"; // 订阅转换后端
        
        const browser = await puppeteer.launch(env.BROWSER);
        const page = await browser.newPage();

        try {
            await page.setViewport({ width: 1920, height: 1080 });
            await page.goto(videoUrl, { waitUntil: "networkidle2" });

            // 1. 播放视频并隐藏 UI
            await page.evaluate(() => {
                const video = document.querySelector('video');
                if (video) video.play();
                const controls = document.querySelector('.ytp-chrome-bottom');
                if (controls) controls.style.display = 'none';
            });

            // 等待画面稳定
            await new Promise(r => setTimeout(r, 5000));

            // 2. 在浏览器内部注入 jsQR 并识别二维码
            // 我们通过 evaluate 执行一段复杂的 JS，直接返回识别出的字符串
            const nodeLink = await page.evaluate(async () => {
                // 动态加载 jsQR 库
                const script = document.createElement('script');
                script.src = "https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js";
                document.head.appendChild(script);
                
                await new Promise(r => script.onload = r);

                const video = document.querySelector('video');
                const canvas = document.createElement('canvas');
                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                
                const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
                const code = jsQR(imageData.data, imageData.width, imageData.height);
                
                return code ? code.data : null;
            });

            if (!nodeLink) {
                await browser.close();
                return new Response("未在视频中识别到二维码", { status: 404 });
            }

            // 3. 构建 Clash 订阅链接
            // 订阅转换通常格式: backend/sub?target=clash&url=节点链接(需要编码)
            const encodedNode = encodeURIComponent(nodeLink);
            const clashSubUrl = `${subConverterBase}/sub?target=clash&url=${encodedNode}&insert=false&config=base&emoji=true&list=false&udp=true&tfo=false&scv=false&fdn=false&sort=false`;

            // 4. (可选) 将结果保存到 R2 方便以后查看
            const timestamp = new Date().getTime();
            await env.MY_BUCKET.put(`nodes/${timestamp}.txt`, `Node: ${nodeLink}\nClash: ${clashSubUrl}`);

            await browser.close();

            // 返回结果给用户
            return new Response(JSON.stringify({
                status: "success",
                original_node: nodeLink,
                clash_subscription: clashSubUrl,
                note: "你可以直接将 clash_subscription 复制到 Clash 客户端使用"
            }), {
                headers: { "Content-Type": "application/json" }
            });

        } catch (e) {
            await browser.close();
            return new Response("处理失败: " + e.message, { status: 500 });
        }
    }
};
