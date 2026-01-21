import puppeteer from "@cloudflare/puppeteer";
import jsQR from "jsqr";

export default {
    async fetch(request, env) {
        try {
            const url = new URL(request.url);
            if (url.pathname === "/admin") return await this.handleAdmin(request, env);
            
            // 主程序逻辑：增加重试机制应对 429 错误
            return await this.processVideosWithRetry(env);
        } catch (e) {
            return new Response(`
                <div style="padding:20px;font-family:sans-serif;background:#fff5f5;border:1px solid #ffcccc;border-radius:8px;">
                    <h3 style="color:#d9534f;">⚠️ 触发系统保护</h3>
                    <p>错误详情: ${e.message}</p>
                    <p><strong>建议方案：</strong> Cloudflare 限制了浏览器启动频率。请<b>等待 2-5 分钟</b>后再刷新页面。同时请确保后台仅保留 1 个监控链接。</p>
                    <button onclick="location.reload()">尝试刷新</button>
                </div>
            `, { headers: { "Content-Type": "text/html;charset=UTF-8" } });
        }
    },

    async handleAdmin(request, env) {
        const ADMIN_PASSWORD = "admin"; 
        if (request.method === "POST") {
            const data = await request.formData();
            if (data.get("password") !== ADMIN_PASSWORD) return new Response("密码错误", { status: 403 });
            const urls = data.get("urls").split("\n").map(u => u.trim()).filter(u => u.startsWith("http"));
            await env.URL_KV.put("TARGET_URLS", JSON.stringify(urls));
            return new Response("<script>alert('保存成功！');location.href='/admin';</script>", { headers: { "Content-Type": "text/html;charset=UTF-8" } });
        }
        let displayUrls = ["https://www.youtube.com/watch?v=V1nVrDSZmSE"];
        const stored = await env.URL_KV.get("TARGET_URLS");
        if (stored) displayUrls = JSON.parse(stored);

        return new Response(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>管理</title><style>body{font-family:sans-serif;padding:30px;background:#f4f4f9;}.box{background:#fff;padding:20px;border-radius:8px;max-width:500px;margin:auto;box-shadow:0 2px 10px rgba(0,0,0,0.1);}textarea{width:100%;height:150px;margin:10px 0;box-sizing:border-box;}button{width:100%;padding:10px;background:#007bff;color:#fff;border:none;border-radius:4px;cursor:pointer;width:100%;}</style></head><body><div class="box"><h2>⚙️ 监控列表管理</h2><form method="POST"><textarea name="urls" placeholder="建议只填1个链接">${displayUrls.join("\n")}</textarea><input type="password" name="password" placeholder="管理密码" style="width:100%;margin-bottom:10px;padding:8px;box-sizing:border-box;"><button type="submit">保存更新</button></form><br><a href="/">返回首页</a></div></body></html>`, { headers: { "Content-Type": "text/html;charset=UTF-8" } });
    },

    async processVideosWithRetry(env, retryCount = 0) {
        const subConverterBase = "https://sb.leelaotou.us.kg";
        let videoUrls = ["https://www.youtube.com/watch?v=V1nVrDSZmSE"];
        const stored = await env.URL_KV.get("TARGET_URLS");
        if (stored) videoUrls = JSON.parse(stored);

        const limitedUrls = videoUrls.slice(0, 1); // 极其重要：免费版强制限制为 1 个视频以防 429/1102
        
        let browser;
        try {
            browser = await puppeteer.launch(env.BROWSER);
        } catch (e) {
            // 如果是 429 频率限制且重试次数少于 1，则等待 2 秒重试一次
            if (e.message.includes("429") && retryCount < 1) {
                await new Promise(r => setTimeout(r, 2000));
                return this.processVideosWithRetry(env, retryCount + 1);
            }
            throw e;
        }

        let allNodes = [];
        let screenshotData = [];

        try {
            for (const url of limitedUrls) {
                const page = await browser.newPage();
                // 拦截资源减小内存占用
                await page.setRequestInterception(true);
                page.on('request', r => ['image','stylesheet','font'].includes(r.resourceType()) ? r.abort() : r.continue());

                await page.setViewport({ width: 640, height: 360 });
                await page.goto(url, { waitUntil: "networkidle2", timeout: 25000 });
                
                await new Promise(r => setTimeout(r, 4000));

                const res = await page.evaluate(() => {
                    const v = document.querySelector('video');
                    if(!v) return null;
                    const canvas = document.createElement('canvas');
                    canvas.width = 480; canvas.height = 270;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(v, 0, 0, 480, 270);
                    return {
                        pixels: Array.from(ctx.getImageData(0, 0, 480, 270).data),
                        w: 480, h: 270,
                        img: canvas.toDataURL('image/jpeg', 0.2)
                    };
                });

                if (res) {
                    const code = jsQR(new Uint8ClampedArray(res.pixels), res.w, res.h);
                    if (code) {
                        allNodes.push(code.data);
                        screenshotData.push({ url, img: res.img });
                    }
                }
                await page.close();
            }
        } finally {
            if (browser) await browser.close();
        }

        if (allNodes.length === 0) return new Response("识别失败。请检查视频中是否有二维码，或尝试刷新。");

        const combined = allNodes.join("|");
        const encoded = encodeURIComponent(combined);
        const links = {
            "V2Ray": `${subConverterBase}/xray?config=${encoded}`,
            "Clash": `${subConverterBase}/sub?target=clash&url=${encoded}`,
            "Sing-box": `${subConverterBase}/sub?target=singbox&url=${encoded}`
        };

        return new Response(this.renderMainUI(links, screenshotData), { headers: { "Content-Type": "text/html;charset=UTF-8" } });
    },

    renderMainUI(links, shots) {
        return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>节点聚合</title><style>body{font-family:sans-serif;background:#f0f2f5;display:flex;flex-direction:column;align-items:center;padding:20px;}.card{background:#fff;border-radius:12px;padding:20px;width:100%;max-width:500px;box-shadow:0 4px 15px rgba(0,0,0,0.05);}.grid img{width:100%;border-radius:8px;margin-bottom:10px;}.link-item{margin:10px 0;padding-bottom:10px;border-bottom:1px solid #eee;}button{padding:5px 10px;background:#28a745;color:#fff;border:none;border-radius:4px;cursor:pointer;}input{width:65%;font-size:11px;padding:4px;}</style></head><body><div class="card"><h3>📷 实况画面</h3><div class="grid">${shots.map(s => `<img src="${s.img}">`).join('')}</div><hr><h3>🔗 订阅链接</h3>${Object.entries(links).map(([name, url]) => `<div class="link-item"><p style="font-size:12px;color:#666;margin:0;">${name}</p><input type="text" value="${url}" id="${name}"><button onclick="copy('${name}')">复制</button></div>`).join('')}</div><br><a href="/admin" style="color:#999;text-decoration:none;font-size:12px;">⚙️ 管理配置</a><script>function copy(id){const i=document.getElementById(id);i.select();navigator.clipboard.writeText(i.value);alert('已复制');}</script></body></html>`;
    }
};
