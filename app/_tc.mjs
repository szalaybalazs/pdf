import { JSDOM } from "jsdom"; import fs from "fs";
const html = fs.readFileSync(new URL("./renderer/index.html","file://"+process.cwd()+"/"),"utf8");
const dom = new JSDOM(html,{runScripts:"outside-only",url:"https://x.test/"});
globalThis.window=dom.window; globalThis.document=dom.window.document; globalThis.localStorage=dom.window.localStorage;
dom.window.katex={renderToString:(t)=>`<span class=katex>${t}</span>`};
dom.window.mermaid={initialize:()=>{},render:async()=>({svg:""})};
let cb=()=>{}; const sent=[];
dom.window.api={onServeEvent:c=>{cb=c},onServeLog:()=>{},sendRequest:r=>sent.push(r),openFigure:async()=>""};
globalThis.window.api=dom.window.api;
await import("./dist/renderer.js");
cb({type:"ready",docs:["A.pdf"],chunks:1,vision_model:"gpt-4o",embed_model:"x"});
document.getElementById("input").value="q"; document.getElementById("send").click();
const reqId=sent[sent.length-1].reqId;
// simulate a calculate tool event in the trace
cb({type:"tool",reqId,name:"calculate",args:"100*10**((50-90)/10)",detail:["= 0.01"],debug:[],duration:0});
cb({type:"answer",reqId,text:"Power is **0.01 W**.",thinking:"",sources:[],usage:{prompt:1,completion:1,total:2},
  calculations:[
    {expression:"100*10**((50-90)/10)",ok:true,result:"0.01",verified:true},
    {expression:"sqrt(2*8)",ok:true,result:"4",verified:false},
    {expression:"2+",ok:false,error:"SyntaxError"}
  ]});
await new Promise(r=>setTimeout(r,20));
const h=document.getElementById("messages").innerHTML;
const ok=(n,c)=>console.log(c?"PASS":"FAIL",n);
ok("calculate shows in trace",/calculate[\s\S]*= 0\.01/.test(h));
ok("verified block present",/verified calculations \(3\)/.test(h));
ok("ok+verified -> check",/calc-ok">✓<[\s\S]*100\*10/.test(h));
ok("ok+not-in-text -> warn",/calc-warn">⚠<[\s\S]*sqrt/.test(h));
ok("error -> cross",/calc-bad">✕<[\s\S]*2\+/.test(h));
ok("error shows message",/SyntaxError/.test(h));
