import puppeteer from "@cloudflare/puppeteer";
import jsQR from "jsqr";

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        // 管理后台页面路径
        if (url.pathname === "/admin") {
            return await this.handleAdmin(request, env);
        }

        // 默认运行爬虫逻辑
        return await this.processVideos(env);
    },

    // 1. 管理后台逻辑
    async handleAdmin(request, env) {
        const ADMIN_PASSWORD = "your_password_here"; // 【请修改你的后台密码】

        if (request.method === "POST") {
            const data = await request.formData();
            const password = data.get("password");
            const urls = data.get("urls").split("\n").map(u => u.trim()).filter(u => u);

            if (password !== ADMIN_PASSWORD) return new Response("密码错误", { status: 403 });

            await env.URL_KV.put("TARGET_URLS", JSON.stringify(urls));
            return new Response("<script>alert('保存成功！');location.href='/admin';</script>", { headers: { "Content-Type": "text/html" } });
        }

        const currentUrls = JSON.parse(await env.URL_KV.get("TARGET_URLS") || '["https://www.youtube.com/watch?v=V1nVrDSZmSE"]');

        return new Response(`
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8"><title>管理后台</title>
                <style>
                    body { font-family: sans-serif; padding: 50px; background: #f0f2f5; }
                    .container { background: white; padding: 20px; border-radius: 8px; max-width: 600px; margin: auto; }
                    textarea { width: 100%; height: 200px; margin: 10px 0; font-family: monospace; }
                    button { background: #007bff; color: white; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer; }
                </style>
            </head>
            <body>
                <div class="container">
                    <h2>监控视频列表管理</h2>
                    <form method="POST">
                        <label>每行输入一个 YouTube 地址：</label>
                        <textarea name="urls">${currentUrls.join("\n")}</textarea>
                        <input type="password" name="password" placeholder="管理密码" required style="width:96%; padding:10px; margin-bottom:10px;">
                        <button type="submit">保存并更新</button>
                    </form>
                    <p><a href="/">← 返回截图页面</a></p>
                </div>
            </body>
            </html>
        `, { headers: { "Content-Type": "text/html" } });
    },

    // 2. 爬虫与合并逻辑
    async processVideos(env) {
        const subConverterBase = "https://sb.leelaotou.us.kg";
        const urlsJson = await env.URL_KV.get("TARGET_URLS");
        const videoUrls = urlsJson ? JSON.parse(urlsJson) : ["https://www.youtube.com/watch?v=V1nVrDSZmSE"];

        const browser = await puppeteer.launch(env.BROWSER);
        let allNodes = [];
        let screenshotData = [];

        try {
            for (let url of videoUrls) {
                const page = await browser.newPage();
                await page.setViewport({ width: 1280, height: 720 });
                try {
                    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
                    await page.evaluate(() => {
                        const v = document.querySelector('video');
                        if(v) v.play();
                        if(document.querySelector('.ytp-chrome-bottom')) document.querySelector('.ytp-chrome-bottom').style.display='none';
                    });
                    await new Promise(r => setTimeout(r, 6000));
                    
                    const res = await page.evaluate(() => {
                        const v = document.querySelector('video');
                        const canvas = document.createElement('canvas');
                        canvas.width = v.videoWidth; canvas.height = v.videoHeight;
                        const ctx = canvas.getContext('2d');
                        ctx.drawImage(v, 0, 0);
                        return {
                            pixels: Array.from(ctx.getImageData(0, 0, canvas.width, canvas.height).data),
                            w: canvas.width, h: canvas.height,
                            img: canvas.toDataURL('image/jpeg', 0.5)
                        };
                    });

                    const code = jsQR(new Uint8ClampedArray(res.pixels), res.w, res.h);
                    if (code) {
                        allNodes.push(code.data);
                        screenshotData.push({ url, img: res.img });
                    }
                } catch (err) { console.log(`跳过错误页面: ${url}`); }
                await page.close();
            }
            await browser.close();

            if (allNodes.length === 0) return new Response("未能从任何视频中提取到节点，请检查视频是否正在直播或调整监控列表。", { status: 404 });

            // 合并所有节点链接
            const combinedNodes = allNodes.join("|");
            const encoded = encodeURIComponent(combinedNodes);

            const subLinks = {
                "V2Ray": `${subConverterBase}/xray?config=${encoded}`,
                "Clash": `${subConverterBase}/sub?target=clash&url=${encoded}&emoji=true&list=false`,
                "Singbox": `${subConverterBase}/sub?target=singbox&url=${encoded}&emoji=true&list=false`
            };

            return new Response(this.renderUI(subLinks, screenshotData), { headers: { "Content-Type": "text/html;charset=UTF-8" } });
        } catch (e) {
            return new Response("运行出错: " + e.message);
        }
    },

    renderUI(links, shots) {
        // 返回美化后的页面，包含一键复制和多图展示
        return `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8"><title>聚合订阅提取</title>
                <style>
                    body { font-family: -apple-system, sans-serif; background: #f4f7f9; padding: 20px; display: flex; flex-direction: column; align-items: center; }
                    .card { background: white; border-radius: 12px; padding: 20px; width: 100%; max-width: 600px; box-shadow: 0 4px 10px rgba(0,0,0,0.05); margin-bottom: 20px; }
                    .shot-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 15px; }
                    .shot-grid img { width: 100%; border-radius: 4px; border: 1px solid #eee; }
                    .link-box { margin: 10px 0; }
                    input { width: 75%; padding: 8px; border: 1px solid #ddd; border-radius: 4px; }
                    button { padding: 8px 12px; background: #28a745; color: white; border: none; cursor: pointer; border-radius: 4px; }
                    .admin-link { margin-top: 20px; color: #999; text-decoration: none; font-size: 0.8rem; }
                </style>
            </head>
            <body>
                <div class="card">
                    <h3>📹 监控列表截图 (${shots.length} 个活跃源)</h3>
                    <div class="shot-grid">${shots.map(s => `<img src="${s.img}" title="${s.url}">`).join('')}</div>
                    <hr>
                    <h3>🚀 聚合订阅链接 (已合并)</h3>
                    ${Object.entries(links).map(([name, link]) => `
                        <div class="link-box">
                            <label style="display:block; font-size:0.8rem; font-weight:bold;">${name}</label>
                            <input type="text" value="${link}" id="${name}" readonly>
                            <button onclick="copy('${name}')">复制</button>
                        </div>
                    `).join('')}
                </div>
                <a href="/admin" class="admin-link">⚙️ 管理监控列表</a>
                <script>
                    function copy(id) {
                        const el = document.getElementById(id);
                        el.select();
                        navigator.clipboard.writeText(el.value);
                        alert('已复制到剪贴板');
                    }
                </script>
            </body>
            </html>
        `;
    }
};
