'use strict';
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs/promises');const path=require('node:path');
app.on('window-all-closed',()=>{});
// 操作説明画像を描画する。先頭の正方形サムネイルは完成PNGをそのまま使う。
async function run(){
 for(const [source,target,width,height]of [['guide.html','booth-guide.png',1600,1000]]){
  const w=new BrowserWindow({show:false,width,height,useContentSize:true,webPreferences:{sandbox:true,offscreen:true,nodeIntegration:false,contextIsolation:true}});
  await w.loadFile(path.resolve(__dirname,'../booth',source));
  await w.webContents.executeJavaScript('document.fonts.ready');
  await w.webContents.executeJavaScript('Promise.all([...document.images].map(i=>i.decode().catch(()=>{})))');
  await new Promise(resolve=>setTimeout(resolve,250));
  w.webContents.debugger.attach('1.3');
  await w.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
  const shot=await w.webContents.debugger.sendCommand('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,fromSurface:true,clip:{x:0,y:0,width,height,scale:1}});
  await fs.writeFile(path.resolve(__dirname,'../booth',target),Buffer.from(shot.data,'base64'));
  console.log(target,{width,height});w.destroy();
 }
}
app.whenReady().then(run).then(()=>app.quit()).catch(e=>{console.error(e);app.exit(1)});
