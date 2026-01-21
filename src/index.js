import puppeteer from "@cloudflare/puppeteer";
import jsQR from "jsqr";

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        // 路由分发
        if (url.pathname === "/admin") {
            return await this.handleAdmin(request, env);
        }

        return await this.processVideos(env);
    },

    // 1. 管理后台逻辑
    async handleAdmin(request, env) {
        const ADMIN_PASSWORD = "admin"; // 建议修改此默认密码

        if (request.method === "POST") {
            try {
                const data = await request.formData();
                const password = data.get("password");
                const urlsText = data.get("urls");

                if (password !== ADMIN_PASSWORD) return new Response("密码错误！", { status: 403 });

                const urls = urlsText.split("\n").map(u => u.trim()).filter(u => u.startsWith("http"));
                await env.URL_KV.put("TARGET_URLS", JSON.stringify(urls));
                return new Response("<script>alert('保存成功！');location.href='/admin';</script>", { headers: { "Content-Type": "text/html;charset=UTF-8" } });
            } catch (e) {
                return new Response("提交失败: " + e.message, { status: 500 });
            }
        }

        // 修复变量名不一致问题，增加 KV 读取容错
        let displayUrls = ["https://www.youtube.com/watch?v=V1nVrDSZmSE"]; 
        try {
            const stored = await env.URL_KV.get("TARGET_URLS");
            if (stored) {
                displayUrls = JSON.parse(stored);
            }
        } catch (e) {
            console.error("KV读取受限");
        }

        return new Response(`
            <!DOCTYPE html>
            <html>
            <head><meta charset="UTF-8"><title>管理监控源</title>
            <style>
                body{font-family:sans-serif;padding:30px;background:#f4f4f9;display:flex;justify-content:center;}
                .box{background:#fff;padding:25px;border-radius:12px;width:100%;max-width:450px;box-shadow:0 4px 15px rgba(0,0,0,0.1);}
                textarea{width:100%;height:150px;margin:12px 0;padding:10px;box-sizing:border-box;border:1px solid #ddd;border-radius:4px;font-family:monospace;}
                input{width:100%;padding:12px;margin:10px 0;box-sizing:border-box;border:1px solid #ddd;border-radius:4px;}
                button{width:100%;padding:12px;background:#007bff;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:bold;}
                button:hover{background:#0056b3;}
                .back{display:block;margin-top:15px;text-align:center;color:#666;text-decoration:none;font-size:0.9rem;}
            </style></head>
            <body><div class="box">
                <h2>⚙️ 监控列表管理</h2>
                <form method="POST">
                    <label style="font-size:0.9rem;color:#444;">YouTube 链接 (每行一个):</label>
                    <textarea name="urls" placeholder="https://www.youtube.com/watch?v=...">${displayUrls.join("\n")}</textarea>
                    <input type="password" name="password" placeholder="请输入管理密码" required>
                    <button type="submit">保存更新</button>
                </form>
                <a href="/" class="back">← 返回首页查看节点</a>
            </div></body></html>
        `, { headers: { "Content-Type": "text/html;charset=UTF-8" } });
    },

    // 2. 核心视频处理逻辑
    async processVideos(env) {
        const subConverterBase = "https://sb.leelaotou.us.kg";
        
        // 读取配置
        let videoUrls = ["https://www.youtube.com/watch?v=V1nVrDSZmSE"];
        try {
            const stored = await env.URL_KV.get("TARGET_URLS");
            if (stored) videoUrls = JSON.parse(stored);
        } catch(e) {}

        // 【性能关键】免费版 Worker 严禁处理超过 2 个视频，否则必报 1102
        const limitedUrls = videoUrls.slice(0, 2);
        
        const browser = await puppeteer.launch(env.BROWSER);
        let allNodes = [];
        let screenshotData = [];

        try {
            for (const url of limitedUrls) {
                let page = null;
                try {
                    page = await browser.newPage();
                    // 【性能关键】极低分辨率渲染，节省内存空间
                    await page.setViewport({ width: 720, height: 480 });
                    
                    // 增加超时控制，防止单个死循环拖垮整个进程
                    await page.goto(url, { waitUntil: "networkidle2", timeout: 20000 });
                    
                    await page.evaluate(() => {
                        const v = document.querySelector('video');
                        if(v) v.play();
                    });
                    
                    // 给视频一点加载时间
                    await new Promise(r => setTimeout(r, 4000));

                    const res = await page.evaluate(() => {
                        const v = document.querySelector('video');
                        if(!v || v.videoWidth === 0) return null;
                        const canvas = document.createElement('canvas');
                        // 【性能关键】画布二次压缩，降低 CPU 识别负担
                        canvas.width = 640; 
                        canvas.height = 360;
                        const ctx = canvas.getContext('2d');
                        ctx.drawImage(v, 0, 0, 640, 360);
                        return {
                            pixels: Array.from(ctx.getImageData(0, 0, 640, 360).data),
                            w: 640, h: 360,
                            img: canvas.toDataURL('image/jpeg', 0.3) // 极低质量图片，防止 Response 过大
                        };
                    });

                    if (res) {
                        const code = jsQR(new Uint8ClampedArray(res.pixels), res.w, res.h);
                        if (code) {
                            allNodes.push(code.data);
                            screenshotData.push({ url, img: res.img });
                        }
                    }
                } catch (e) {
                    console.error("跳过失败源: " + url);
                } finally {
                    if (page) await page.close(); // 必须！处理完一个立刻释放内存
                }
            }
        } finally {
            await browser.close();
        }

        if (allNodes.length === 0) {
            return new Response("未能识别到二维码。请检查视频是否在线，或尝试减少监控数量。", { status: 200 });
        }

        // 合并节点
        const combined = allNodes.join("|");
        const encoded = encodeURIComponent(combined);

        const links = {
            "V2Ray (xray)": `${subConverterBase}/xray?config=${encoded}`,
            "Clash": `${subConverterBase}/sub?target=clash&url=${encoded}&insert=false&emoji=true`,
            "Sing-box": `${subConverterBase}/sub?target=singbox&url=${encoded}&insert=false&emoji=true`
        };

        return new Response(this.renderMainUI(links, screenshotData), { headers: { "Content-Type": "text/html;charset=UTF-8" } });
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
                .link-item{margin:15px 0;border-bottom:1px solid #f0f0f0;padding-bottom:12px;}
                input{width:70%;padding:10px;border:1px solid #ddd;border-radius:4px;background:#fafafa;font-size:12px;color:#333;}
                button{padding:10px 15px;background:#28a745;color:#fff;border:none;border-radius:4px;cursor:pointer;font-weight:bold;}
                .admin-btn{color:#999;text-decoration:none;font-size:0.8rem;margin-top:10px;}
            </style></head>
            <body>
                <div class="card">
                    <h3 style="margin-top:0;">📷 实况监控画面 (${shots.length})</h3>
                    <div class="grid">${shots.map(s => `<img src="${s.img}" title="${s.url}">`).join('')}</div>
                    <hr style="border:0;border-top:1px solid #eee;margin:20px 0;">
                    <h3>🚀 聚合订阅链接</h3>
                    ${Object.entries(links).map(([name, url]) => `
                        <div class="link-item">
                            <label style="display:block;font-size:0.75rem;color:#888;margin-bottom:4px;">${name} 格式</label>
                            <div style="display:flex;gap:5px;">
                                <input type="text" value="${url}" id="${name}" readonly>
                                <button onclick="copy('${name}')">复制</button>
                            </div>
                        </div>
                    `).join('')}
                </div>
                <a href="/admin" class="admin-btn">⚙️ 管理监控列表及密码</a>
                <script>
                    async function copy(id){
                        const i = document.getElementById(id);
                        i.select();
                        try {
                            await navigator.clipboard.writeText(i.value);
                            const btn = event.target;
                            const oldText = btn.innerText;
                            btn.innerText = '已复制';
                            btn.style.background = '#007bff';
                            setTimeout(() => { btn.innerText = oldText; btn.style.background = '#28a745'; }, 2000);
                        } catch (err) { alert('复制失败，请手动选择复制'); }
                    }
                </script>
            </body></html>
        `;
    }
};
