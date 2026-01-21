import puppeteer from "@cloudflare/puppeteer";
import jsQR from "jsqr";

export default {
    async fetch(request, env) {
        try {
            const url = new URL(request.url);
            // 1. 管理后台路由
            if (url.pathname === "/admin") {
                return await this.handleAdmin(request, env);
            }
            // 2. 主程序逻辑
            return await this.processVideos(env);
        } catch (e) {
            // 彻底杜绝 1101，将错误信息直接输出到页面
            return new Response(`【系统错误】${e.message}\n建议：尝试减少后台监控链接数量，或稍后再试。`, { status: 200 });
        }
    },

    // 管理后台
    async handleAdmin(request, env) {
        const ADMIN_PASSWORD = "admin"; 

        if (request.method === "POST") {
            const data = await request.formData();
            if (data.get("password") !== ADMIN_PASSWORD) return new Response("密码错误！", { status: 403 });
            const urls = data.get("urls").split("\n").map(u => u.trim()).filter(u => u.startsWith("http"));
            await env.URL_KV.put("TARGET_URLS", JSON.stringify(urls));
            return new Response("<script>alert('保存成功！');location.href='/admin';</script>", { headers: { "Content-Type": "text/html;charset=UTF-8" } });
        }

        let displayUrls = ["https://www.youtube.com/watch?v=V1nVrDSZmSE"]; 
        const stored = await env.URL_KV.get("TARGET_URLS");
        if (stored) displayUrls = JSON.parse(stored);

        return new Response(`
            <!DOCTYPE html><html><head><meta charset="UTF-8"><title>管理</title>
            <style>body{font-family:sans-serif;padding:30px;background:#f4f4f9;}.box{background:#fff;padding:20px;border-radius:8px;max-width:500px;margin:auto;box-shadow:0 2px 10px rgba(0,0,0,0.1);}textarea{width:100%;height:150px;margin:10px 0;box-sizing:border-box;}button{width:100%;padding:10px;background:#007bff;color:#fff;border:none;border-radius:4px;cursor:pointer;width:100%;}</style></head>
            <body><div class="box"><h2>⚙️ 监控列表管理</h2><form method="POST"><textarea name="urls">${displayUrls.join("\n")}</textarea><input type="password" name="password" placeholder="管理密码" style="width:100%;margin-bottom:10px;padding:8px;box-sizing:border-box;"><button type="submit">保存更新</button></form><br><a href="/">返回首页</a></div></body></html>
        `, { headers: { "Content-Type": "text/html;charset=UTF-8" } });
    },

    // 核心处理逻辑
    async processVideos(env) {
        const subConverterBase = "https://sb.leelaotou.us.kg";
        let videoUrls = ["https://www.youtube.com/watch?v=V1nVrDSZmSE"];
        const stored = await env.URL_KV.get("TARGET_URLS");
        if (stored) videoUrls = JSON.parse(stored);

        // 免费版只建议跑 1 个，最多 2 个
        const limitedUrls = videoUrls.slice(0, 2);
        const browser = await puppeteer.launch(env.BROWSER);
        let allNodes = [];
        let screenshotData = [];

        try {
            for (const url of limitedUrls) {
                const page = await browser.newPage();
                
                // 【关键优化：请求拦截】禁用图片、CSS、字体加载，极大节省内存
                await page.setRequestInterception(true);
                page.on('request', (req) => {
                    const resourceType = req.resourceType();
                    if (['image', 'stylesheet', 'font', 'media'].includes(resourceType) && resourceType !== 'media') {
                        req.abort();
                    } else {
                        req.continue();
                    }
                });

                await page.setViewport({ width: 640, height: 360 });
                
                try {
                    // 缩短超时时间
                    await page.goto(url, { waitUntil: "networkidle2", timeout: 20000 });
                    
                    // 尝试播放
                    await page.evaluate(() => {
                        const v = document.querySelector('video');
                        if(v) v.play();
                    });
                    
                    await new Promise(r => setTimeout(r, 4000));

                    const res = await page.evaluate(() => {
                        const v = document.querySelector('video');
                        if(!v) return null;
                        const canvas = document.createElement('canvas');
                        canvas.width = 480; canvas.height = 270; // 进一步压缩画布
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
                } catch (e) {
                    console.error("单个任务失败");
                } finally {
                    await page.close(); // 确保及时释放内存
                }
            }
        } finally {
            await browser.close();
        }

        if (allNodes.length === 0) return new Response("未能识别二维码。请尝试：1. 减少后台链接至 1 个 2. 刷新重试 3. 检查视频源是否包含二维码。");

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
        return `
            <!DOCTYPE html><html><head><meta charset="UTF-8"><title>节点聚合</title>
            <style>body{font-family:sans-serif;background:#f0f2f5;display:flex;flex-direction:column;align-items:center;padding:20px;}.card{background:#fff;border-radius:12px;padding:20px;width:100%;max-width:500px;box-shadow:0 4px 15px rgba(0,0,0,0.05);}.grid img{width:100%;border-radius:8px;margin-bottom:10px;}.link-item{margin:10px 0;padding-bottom:10px;border-bottom:1px solid #eee;}button{padding:5px 10px;background:#28a745;color:#fff;border:none;border-radius:4px;cursor:pointer;}</style></head>
            <body><div class="card">
                <h3>📷 实况画面</h3><div class="grid">${shots.map(s => `<img src="${s.img}">`).join('')}</div><hr>
                <h3>🔗 订阅链接</h3>
                ${Object.entries(links).map(([name, url]) => `<div class="link-item"><p style="font-size:12px;color:#666;margin:0;">${name}</p><input type="text" value="${url}" style="width:70%;font-size:10px;" id="${name}"><button onclick="copy('${name}')">复制</button></div>`).join('')}
            </div><br><a href="/admin" style="color:#999;text-decoration:none;font-size:12px;">⚙️ 管理配置</a>
            <script>function copy(id){const i=document.getElementById(id);i.select();navigator.clipboard.writeText(i.value);alert('已复制');}</script></body></html>
        `;
    }
};
