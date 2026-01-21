import puppeteer from "@cloudflare/puppeteer";
import jsQR from "jsqr";

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        // 1. 管理后台路由
        if (url.pathname === "/admin") {
            return await this.handleAdmin(request, env);
        }

        // 2. 主程序逻辑
        return await this.processVideos(env);
    },

    // 管理后台界面
    async handleAdmin(request, env) {
        const ADMIN_PASSWORD = "admin"; // 【记得在这里修改密码】

        if (request.method === "POST") {
            try {
                const data = await request.formData();
                const password = data.get("password");
                const urlsText = data.get("urls");

                if (password !== ADMIN_PASSWORD) return new Response("密码错误！", { status: 403 });

                const urls = urlsText.split("\n").map(u => u.trim()).filter(u => u.startsWith("http"));
                await env.URL_KV.put("TARGET_URLS", JSON.stringify(urls));
                return new Response("<script>alert('保存成功！');location.href='/admin';</script>", { headers: { "Content-Type": "text/html" } });
            } catch (e) {
                return new Response("提交失败: " + e.message, { status: 500 });
            }
        }

        // --- 修复点：统一变量名为 displayUrls ---
        let displayUrls = ["https://www.youtube.com/watch?v=V1nVrDSZmSE"]; 
        try {
            const stored = await env.URL_KV.get("TARGET_URLS");
            if (stored) {
                displayUrls = JSON.parse(stored);
            }
        } catch (e) {
            console.error("KV读取失败，使用默认列表");
        }

        return new Response(`
            <!DOCTYPE html>
            <html>
            <head><meta charset="UTF-8"><title>监控列表管理</title>
            <style>body{font-family:sans-serif;padding:30px;background:#f4f4f9;}.box{background:#fff;padding:20px;border-radius:8px;max-width:500px;margin:auto;box-shadow:0 2px 10px rgba(0,0,0,0.1);}textarea{width:100%;height:150px;margin:10px 0;}input{width:100%;padding:10px;margin:10px 0;box-sizing:border-box;}button{width:100%;padding:10px;background:#007bff;color:#fff;border:none;border-radius:4px;cursor:pointer;}</style></head>
            <body><div class="box">
                <h2>⚙️ 监控列表管理</h2>
                <form method="POST">
                    <label>视频链接 (每行一个):</label>
                    <textarea name="urls">${displayUrls.join("\n")}</textarea>
                    <input type="password" name="password" placeholder="输入后台密码" required>
                    <button type="submit">保存更新</button>
                </form>
                <br><a href="/">返回首页</a>
            </div></body></html>
        `, { headers: { "Content-Type": "text/html;charset=UTF-8" } });
    },

    // 核心识别逻辑
    async processVideos(env) {
        const subConverterBase = "https://sb.leelaotou.us.kg";
        
        // 增加兜底逻辑，防止 KV 异常导致首页崩溃
        let videoUrls = ["https://www.youtube.com/watch?v=V1nVrDSZmSE"];
        try {
            const stored = await env.URL_KV.get("TARGET_URLS");
            if (stored) videoUrls = JSON.parse(stored);
        } catch(e) { console.error("KV访问受限"); }

        const browser = await puppeteer.launch(env.BROWSER);
        let allNodes = [];
        let screenshotData = [];

        try {
            for (const url of videoUrls) {
                const page = await browser.newPage();
                await page.setViewport({ width: 1280, height: 720 });
                try {
                    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
                    await page.evaluate(() => {
                        const v = document.querySelector('video');
                        if(v) v.play();
                    });
                    await new Promise(r => setTimeout(r, 6000));

                    const res = await page.evaluate(() => {
                        const v = document.querySelector('video');
                        if(!v) return null;
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

                    if (res) {
                        const code = jsQR(new Uint8ClampedArray(res.pixels), res.w, res.h);
                        if (code) {
                            allNodes.push(code.data);
                            screenshotData.push({ url, img: res.img });
                        }
                    }
                } catch (e) { console.log("视频加载失败: " + url); }
                await page.close();
            }
            await browser.close();

            if (allNodes.length === 0) return new Response("未能识别到二维码，请检查监控视频是否在线。", { status: 404 });

            const combined = allNodes.join("|");
            const encoded = encodeURIComponent(combined);

            const links = {
                "V2Ray (xray)": `${subConverterBase}/xray?config=${encoded}`,
                "Clash": `${subConverterBase}/sub?target=clash&url=${encoded}&insert=false&emoji=true`,
                "Sing-box": `${subConverterBase}/sub?target=singbox&url=${encoded}&insert=false&emoji=true`
            };

            return new Response(this.renderMainUI(links, screenshotData), { headers: { "Content-Type": "text/html;charset=UTF-8" } });
        } catch (err) {
            if (browser) await browser.close();
            return new Response("发生错误: " + err.message, { status: 500 });
        }
    },

    renderMainUI(links, shots) {
        return `
            <!DOCTYPE html>
            <html>
            <head><meta charset="UTF-8"><title>节点聚合面板</title>
            <style>
                body{font-family:-apple-system,sans-serif;background:#f0f2f5;display:flex;flex-direction:column;align-items:center;padding:20px;}
                .card{background:#fff;border-radius:12px;padding:20px;width:100%;max-width:600px;box-shadow:0 4px 15px rgba(0,0,0,0.05);margin-bottom:20px;}
                .grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:15px 0;}
                .grid img{width:100%;border-radius:8px;border:1px solid #eee;}
                .link-item{margin:15px 0;border-bottom:1px solid #f0f0f0;padding-bottom:10px;}
                input{width:70%;padding:8px;border:1px solid #ddd;border-radius:4px;background:#fafafa;font-size:12px;}
                button{padding:8px 12px;background:#28a745;color:#fff;border:none;border-radius:4px;cursor:pointer;}
                .admin-btn{color:#999;text-decoration:none;font-size:0.8rem;}
            </style></head>
            <body>
                <div class="card">
                    <h3>📷 实况画面 (${shots.length})</h3>
                    <div class="grid">${shots.map(s => `<img src="${s.img}">`).join('')}</div>
                    <hr>
                    <h3>🔗 聚合订阅链接</h3>
                    ${Object.entries(links).map(([name, url]) => `
                        <div class="link-item">
                            <label style="display:block;font-size:0.8rem;color:#666;">${name}</label>
                            <input type="text" value="${url}" id="${name}" readonly>
                            <button onclick="copy('${name}')">复制</button>
                        </div>
                    `).join('')}
                </div>
                <a href="/admin" class="admin-btn">⚙️ 管理监控源</a>
                <script>
                    function copy(id){
                        const i = document.getElementById(id); i.select();
                        navigator.clipboard.writeText(i.value);
                        const btn = event.target;
                        btn.innerText = '已复制';
                        setTimeout(() => btn.innerText = '复制', 2000);
                    }
                </script>
            </body></html>
        `;
    }
};
