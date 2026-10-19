import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import WebSocket from "ws";

async function main() {
    console.log("1. Starting local recomp server on port 8646...");
    const serverProc = spawn("python", ["recomp-web/serve.py", "recomp-web", "8646"], {
        stdio: "inherit"
    });

    await new Promise(r => setTimeout(r, 1200));

    const tempDir = path.join(os.tmpdir(), "chrome-test-recomp-" + Date.now());
    fs.mkdirSync(tempDir, { recursive: true });

    console.log("2. Starting Headless Chrome with hardware WebGPU...");
    const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
    const chromeProc = spawn(chromePath, [
        "--headless=new",
        "--remote-debugging-port=9339",
        "--no-sandbox",
        "--enable-unsafe-webgpu",
        "--use-angle=d3d11",
        "--autoplay-policy=no-user-gesture-required",
        `--user-data-dir=${tempDir}`,
        "about:blank"
    ]);

    let ws;
    const cleanup = () => {
        try { if (ws) ws.close(); } catch (_) {}
        try { chromeProc.kill(); } catch (_) {}
        try { serverProc.kill(); } catch (_) {}
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
    };

    process.on("SIGINT", cleanup);
    process.on("exit", cleanup);

    await new Promise(r => setTimeout(r, 1500));

    console.log("3. Connecting to Chrome DevTools Protocol...");
    const listRes = await fetch("http://127.0.0.1:9339/json/list");
    const targets = await listRes.json();
    const pageTarget = targets.find(t => t.type === "page") || targets[0];
    ws = new WebSocket(pageTarget.webSocketDebuggerUrl);

    let nextId = 1;
    const callbacks = new Map();

    function sendCmd(method, params = {}) {
        return new Promise((resolve, reject) => {
            const id = nextId++;
            callbacks.set(id, { resolve, reject });
            ws.send(JSON.stringify({ id, method, params }));
        });
    }

    const consoleLogs = [];
    const pageErrors = [];
    let haltMessage = null;

    await new Promise((resolve) => {
        ws.on("open", resolve);
        ws.on("message", (raw) => {
            const msg = JSON.parse(raw.toString());
            if (msg.id && callbacks.has(msg.id)) {
                const { resolve, reject } = callbacks.get(msg.id);
                callbacks.delete(msg.id);
                if (msg.error) reject(msg.error);
                else resolve(msg.result);
            } else if (msg.method === "Runtime.consoleAPICalled") {
                const text = msg.params.args.map(a => a.value ?? a.description ?? "").join(" ");
                consoleLogs.push(`[browser console.${msg.params.type}] ${text}`);
                if (text.includes("stopped after") || text.includes("missing code")) {
                    haltMessage = text;
                    console.error(`[HALT DETECTED] ${text}`);
                }
            } else if (msg.method === "Runtime.exceptionThrown") {
                const desc = msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text;
                pageErrors.push(desc);
                console.error(`[browser exception] ${desc}`);
            }
        });
    });

    await sendCmd("Runtime.enable");
    await sendCmd("Page.enable");
    await sendCmd("Log.enable");

    console.log("4. Navigating to http://127.0.0.1:8646/index.html...");
    await sendCmd("Page.navigate", { url: "http://127.0.0.1:8646/index.html" });

    console.log("5. Waiting for WASM runtime and disc manifest initialization...");
    let ready = false;
    for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 1000));
        const res = await sendCmd("Runtime.evaluate", {
            expression: `({
                startDisabled: document.getElementById('start')?.disabled,
                status: document.getElementById('status')?.textContent
            })`,
            returnByValue: true
        });
        const val = res.result?.value;
        if (val && val.startDisabled === false) {
            console.log(`Ready at tick ${i + 1}:`, val);
            ready = true;
            break;
        }
    }

    if (!ready) {
        console.error("Game did not reach ready state within 30s!");
        cleanup();
        process.exit(1);
    }

    console.log("6. Clicking START to boot the emulator...");
    await sendCmd("Runtime.evaluate", {
        expression: "document.getElementById('start').click()",
        returnByValue: true
    });

    // Monitor for 55 seconds (to pass tick ~3000 frames)
    console.log("7. Monitoring execution for 55 seconds to verify past frame 2,626...");
    let maxFrames = 0;
    for (let i = 0; i < 55; i++) {
        await new Promise(r => setTimeout(r, 1000));
        const stats = await sendCmd("Runtime.evaluate", {
            expression: `({
                frames: window.Module?._ps2web_frames ? window.Module._ps2web_frames() : 0,
                status: document.getElementById('status')?.textContent,
                stats: document.getElementById('stats')?.textContent
            })`,
            returnByValue: true
        });
        const curFrames = stats.result?.value?.frames || 0;
        maxFrames = Math.max(maxFrames, curFrames);
        if ((i + 1) % 5 === 0 || curFrames > 2620 && curFrames < 2700) {
            console.log(`Tick ${i + 1} (${curFrames} frames):`, stats.result?.value);
        }
        if (haltMessage) {
            console.error(`Simulation halted early at frame ${curFrames}: ${haltMessage}`);
            break;
        }
    }

    const hasAsmConstError = pageErrors.some(e => e.includes("ASM_CONSTS"));
    console.log("\n================ LONG RUN TEST SUMMARY ================");
    console.log("Max frames reached:", maxFrames);
    console.log("Passed 2,626 frame barrier?", maxFrames > 2626);
    console.log("Halt message:", haltMessage || "None (clean continuous run)");
    console.log("ASM_CONSTS error present?", hasAsmConstError);
    console.log("Total page exceptions:", pageErrors.length);

    cleanup();
    if (hasAsmConstError || haltMessage || maxFrames <= 2626) {
        console.error("FAILED!");
        process.exit(1);
    } else {
        console.log("SUCCESS: Simulation smoothly progressed past frame 2,626 without halting!");
        process.exit(0);
    }
}

main().catch(e => {
    console.error("Test script failed:", e);
    process.exit(1);
});
