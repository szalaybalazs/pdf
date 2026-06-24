import { JSDOM } from "jsdom"; import fs from "fs";
const html = fs.readFileSync(new URL("./renderer/index.html","file://"+process.cwd()+"/"),"utf8");
const dom = new JSDOM(html,{runScripts:"outside-only",url:"https://x.test/"});
globalThis.window=dom.window; globalThis.document=dom.window.document; globalThis.localStorage=dom.window.localStorage;
dom.window.katex={renderToString:t=>t}; dom.window.mermaid={initialize:()=>{},render:async()=>({svg:""})};
let cb=()=>{}, ingestCb=()=>{}; let addCalled=0;
dom.window.api={ onServeEvent:c=>{cb=c}, onServeLog:()=>{}, sendRequest:()=>{}, openFigure:async()=>"",
  addPdfs:async()=>{addCalled++; return {canceled:false,count:1};}, onIngestEvent:c=>{ingestCb=c} };
globalThis.window.api=dom.window.api;
await import("./dist/renderer.js");
const ok=(n,c)=>console.log(c?"PASS":"FAIL",n);

// 1) docs list from ready
cb({type:"ready",docs:["Morgan.pdf","Zoran.pdf"],chunks:100,vision_model:"gpt-4o",embed_model:"x"});
ok("doc count from ready", document.getElementById("doc-count").textContent==="2");
ok("doc list rendered", /Morgan/.test(document.getElementById("doc-list").textContent) && /Zoran/.test(document.getElementById("doc-list").textContent));

// 2) Cmd+N creates a new thread
const before = document.querySelectorAll(".thread-item").length;
window.dispatchEvent(new dom.window.KeyboardEvent("keydown",{key:"n",metaKey:true}));
const after = document.querySelectorAll(".thread-item").length;
ok("Cmd+N adds a thread", after===before+1);

// 3) Add PDF button invokes picker
document.getElementById("add-pdf").click();
await new Promise(r=>setTimeout(r,5));
ok("Add PDF calls api.addPdfs", addCalled===1);

// 4) ingest progress events
ingestCb({type:"ingest_start",total:1});
ingestCb({type:"file_start",name:"New.pdf",index:1,total:1});
ok("progress shows indexing", /Indexing New\.pdf \(1\/1\)/.test(document.getElementById("ingest-status").textContent));
ingestCb({type:"ingest_done",added:1,docs:["Morgan.pdf","Zoran.pdf","New.pdf"]});
ok("docs refresh after ingest", document.getElementById("doc-count").textContent==="3" && /New/.test(document.getElementById("doc-list").textContent));
ok("status shows added", /Added 1 document/.test(document.getElementById("ingest-status").textContent));
