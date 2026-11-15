// Local-only real HTTP smoke. The manifest is created by the gated Go/MySQL
// harness; this script never intercepts or fabricates API responses.
const { chromium } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
async function main() {
 const manifestPath = process.env.STRIDE_990_CLIENT_MANIFEST;
 if (!manifestPath) throw new Error("STRIDE_990_CLIENT_MANIFEST required");
 const manifest = JSON.parse(fs.readFileSync(manifestPath,"utf8"));
 if (manifest.url !== "http://127.0.0.1:19890") throw new Error("dedicated loopback API required");
 const url = process.env.STRIDE_LOCAL_URL || "http://127.0.0.1:5184";
 if (new URL(url).hostname !== "127.0.0.1") throw new Error("loopback Vite required");
 const out = process.env.STRIDE_990_SCREENSHOTS;
 if (!out) throw new Error("private screenshot directory required");
 fs.mkdirSync(out,{recursive:true,mode:0o700});
 const browser = await chromium.launch({headless:true,executablePath:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"});
 const evidence=[];
 try {
  for (const c of manifest.cases) {
   const context = await browser.newContext({viewport:{width:390,height:844},hasTouch:true});
   await context.addInitScript(({token})=>{sessionStorage.setItem("access_token",token);sessionStorage.setItem("refresh_token","local-only-unused");},{token:c.token});
   const page = await context.newPage();
   const errors=[];page.on("pageerror",e=>errors.push(e.message));
   const read=page.waitForResponse(r=>r.url().includes("/stride/zones") && r.request().method()==="GET");
   await page.goto(url+"/training-status");
   const response=await read;if(!response.ok()) throw new Error(c.name+" zones HTTP "+response.status());
   const text=(await response.text()).trim();
   const hash=crypto.createHash("sha256").update(text).digest("hex");
   if(hash!==c.sha256) throw new Error(c.name+" shared response hash differs");
   await page.getByRole("heading",{name:"训练状态",exact:true}).waitFor();
   const phonePrompt=page.getByRole("dialog",{name:"绑定手机号"});
   if(await phonePrompt.isVisible().catch(()=>false)) await phonePrompt.getByRole("button",{name:"稍后再说",exact:true}).click();
   const speed=page.locator("div.bg-bg-card").filter({has:page.getByText("阈值配速",{exact:true})}).first();
   await speed.getByText(c.expected.pace,{exact:true}).waitFor();
   const hr=page.locator("div.bg-bg-card").filter({has:page.getByText("阈值心率",{exact:true})}).first();
   await hr.getByText(c.expected.hr,{exact:true}).waitFor();
   if(c.expected.hr_range) await hr.getByText(c.expected.hr_range,{exact:true}).waitFor();
   if(c.expected.speed_effort_label && !(await speed.innerText()).includes(c.expected.speed_effort_label)) throw new Error(c.name+" effort label differs");
   if(c.expected.pace_range) await page.getByText(c.expected.pace_range,{exact:true}).waitFor();
   const publicOut = process.env.STRIDE_990_PUBLIC_SCREENSHOTS;
   if (publicOut && c.name === "two-sided") {fs.mkdirSync(publicOut,{recursive:true});await speed.screenshot({path:path.join(publicOut,"web-threshold-390.png"),animations:"disabled"});}
   const summary=page.getByText("阈值配速说明",{exact:true});
   if(c.name === "two-sided") {await summary.tap();await page.getByText("阈值配速估计当前全力可维持约一小时的能力，不是普通训练平均配速。",{exact:true}).waitFor({state:"visible"});await summary.tap();}
   await summary.focus();await page.keyboard.press("Enter");
   await page.getByText("阈值配速估计当前全力可维持约一小时的能力，不是普通训练平均配速。",{exact:true}).waitFor({state:"visible"});
   if(c.expected.evidence_day) await speed.getByText("证据日 "+c.expected.evidence_day,{exact:true}).waitFor();
   if(c.expected.computed_shanghai) await speed.getByText("校准执行 "+c.expected.computed_shanghai+"（上海）",{exact:true}).waitFor();
   if(c.expected.source_unavailable && (await speed.innerText()).includes('估计支持 高')) throw new Error(c.name+' borrowed unsupported source labels');
   if(c.expected.rejected_evidence_day) {
    await hr.getByText("阈值心率说明",{exact:true}).tap();
    if(c.expected.stale_evidence_day) await hr.getByText("最近陈旧协议日 "+c.expected.stale_evidence_day,{exact:true}).waitFor({state:"visible"});
    if(c.expected.rejected_evidence_day !== c.expected.stale_evidence_day) await hr.getByText("最近未采用证据日 "+c.expected.rejected_evidence_day,{exact:true}).waitFor({state:"visible"});
    else if(await hr.getByText("最近未采用证据日 "+c.expected.rejected_evidence_day,{exact:true}).count()) throw new Error(c.name+' duplicated stale/rejected date');
    await hr.getByText("未采用历史协议（不参与当前估计）",{exact:true}).waitFor({state:"visible"});
    if(c.expected.stale_evidence_day) await hr.getByText("未采用协议：协议证据已过期",{exact:true}).waitFor({state:"visible"});
    if(c.name==='producer-stale-hr-mixed' || c.name.endsWith('-quality')) await hr.getByText("未采用协议：心率存在突变或恢复",{exact:true}).waitFor({state:"visible"});
    if(await hr.getByText("证据陈旧，需更新有效证据",{exact:true}).count()) throw new Error(c.name+' historical rejection mislabeled current support');
    if(c.expected.current_hr_supported) {await hr.getByText('估计支持 低',{exact:true}).waitFor();await hr.getByText('证据日 '+c.expected.hr_evidence_day,{exact:true}).waitFor();}
    if ((await hr.innerText()).includes('估计支持 高')) throw new Error(c.name+' stale support revived');
   }
   if(c.expected.hr_method_label) {
    await hr.getByText("阈值心率说明",{exact:true}).tap();
    await hr.getByText(c.expected.hr_method_label,{exact:true}).waitFor({state:"visible"});
    if(c.expected.lab_method && !(await hr.innerText()).includes(c.expected.lab_method)) throw new Error(c.name+" lab method missing");
   }
   const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
   if(overflow) throw new Error(c.name+" narrow viewport overflows");
   await page.screenshot({path:path.join(out,"web-"+c.name+"-390.png"),fullPage:true,animations:"disabled"});
   if(c.name.startsWith("producer-") && publicOut) {
    await page.setViewportSize({width:1440,height:1600});
    await hr.screenshot({path:path.join(publicOut,"web-"+c.name+"-hr.png"),animations:"disabled"});
    await speed.screenshot({path:path.join(publicOut,"web-"+c.name+"-effort.png"),animations:"disabled"});
   }
   if(c.name==="two-sided") {

    await page.setViewportSize({width:1440,height:1400});if(publicOut) await speed.screenshot({path:path.join(publicOut,"web-threshold-help-desktop.png"),animations:"disabled"});await page.screenshot({path:path.join(out,"web-two-sided-desktop.png"),fullPage:true,animations:"disabled"});
    await context.setOffline(true);await page.getByRole("button",{name:"14d",exact:true}).click();
    await page.getByText("训练状态更新失败，请重试",{exact:false}).waitFor();
    await context.setOffline(false);await page.getByRole("button",{name:"重新加载",exact:true}).click();
    await page.getByText("支持范围 3:34–3:36 /km",{exact:true}).waitFor();
   }
   if(errors.length)throw new Error(c.name+" browser runtime errors");
   evidence.push({name:c.name,sha256:hash,pace:c.expected.pace,range:c.expected.pace_range,hr:c.expected.hr,hr_range:c.expected.hr_range,hr_method_label:c.expected.hr_method_label,speed_effort_label:c.expected.speed_effort_label,viewport:390,status:"pass"});
   await context.close();
  }
  fs.writeFileSync(path.join(out,"web-local-evidence.json"),JSON.stringify(evidence,null,2),{mode:0o600});
  console.log("Real local GIN/MySQL/JWT smoke PASS: "+evidence.length+" states, shared response hashes, 390px, desktop, Chrome synthesized touch and keyboard help, offline failure/retry");
 } finally {await browser.close();}
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
