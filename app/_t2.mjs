import { JSDOM } from "jsdom";
import fs from "fs";
const html = fs.readFileSync(new URL("./renderer/index.html","file://"+process.cwd()+"/"),"utf8");
// seed localStorage with a prior session, then "reopen"
const seed = JSON.stringify({ activeId:"t1", threads:[
  { id:"t1", title:"Prior chat", busy:true,
    history:[{role:"user",content:"q"},{role:"assistant",content:"a"}],
    messages:[ {kind:"user",text:"q"},
      {kind:"assistant",reqId:"r",trace:[],text:"prior **answer**",sources:[],done:true} ] }
]});
const dom = new JSDOM(html, { runScripts:"outside-only", url:"https://x.test/" });
dom.window.localStorage.setItem("pdf_qa_threads_v1", seed);
globalThis.window=dom.window; globalThis.document=dom.window.document; globalThis.localStorage=dom.window.localStorage;
dom.window.mermaid={initialize:()=>{},render:async()=>({svg:""})};
dom.window.api={onServeEvent:()=>{},onServeLog:()=>{},sendRequest:()=>{},openFigure:async()=>""};
globalThis.window.api=dom.window.api;
await import("./dist/renderer.js");
const sidebar=document.getElementById("thread-list").textContent;
const msgs=document.getElementById("messages").innerHTML;
console.log((/Prior chat/.test(sidebar)?"PASS":"FAIL"),"thread restored on reopen");
console.log((/prior <strong>answer<\/strong>/.test(msgs)?"PASS":"FAIL"),"prior answer restored + markdown re-rendered");
