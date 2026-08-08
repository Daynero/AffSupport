import { chromium } from 'playwright-core';
const browser = await chromium.launch({ executablePath: process.env.PW_EXEC });
const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 });
const O=process.env.OUT;
await page.goto('http://127.0.0.1:5173/', { waitUntil:'networkidle' });
await page.waitForTimeout(1200);
await page.evaluate(()=>{ document.querySelectorAll('.public-home').forEach(el=>{el.style.background='transparent';}); });
// hover over left edge where accent cells live
async function hoverCount(x,y){
  await page.mouse.move(x-40,y-40); await page.waitForTimeout(90);
  await page.mouse.move(x,y); await page.waitForTimeout(240);
  return await page.evaluate(()=>{let n=0;document.querySelectorAll('.soty-cell').forEach(e=>{if(e.style.transform)n++});return n;});
}
console.log('lifted @ left edge (60,430):', await hoverCount(60,430));
console.log('lifted @ (40,650):', await hoverCount(40,650));
await page.screenshot({ path:O+'/lift-check.png', clip:{x:0,y:300,width:340,height:420} });
await browser.close();
