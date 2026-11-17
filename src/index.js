const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json; charset=UTF-8","cache-control":"no-store","x-content-type-options":"nosniff"}});
const EXPECTED={
 clients:["id","access_token","full_name","phone","goal","experience","training_days","equipment","notes","created_at"],
 programs:["id","client_id","title","phase","content_json","created_at","updated_at"],
 exercise_completions:["id","client_id","exercise_name","completed_at"]
};
const WRITE_ENABLED=env=>String(env.ALLOW_DB_WRITES||"false").toLowerCase()==="true";
async function tableInfo(db,name){
 const r=await db.prepare('PRAGMA table_info("'+name.replace(/"/g,'')+'")').all();
 return r.results||[];
}
async function inspectSchema(db){
 const names=await db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
 const set=new Set((names.results||[]).map(x=>x.name));
 const report={};
 for(const [table,required] of Object.entries(EXPECTED)){
  if(!set.has(table)){report[table]={exists:false,missing:required};continue;}
  const info=await tableInfo(db,table), cols=new Set(info.map(x=>x.name));
  report[table]={exists:true,missing:required.filter(x=>!cols.has(x)),extraRequired:[]};
 }
 const clients=report.clients, programs=report.programs;
 if(clients?.exists&&!clients.missing.length){
  const info=await tableInfo(db,"clients"), supplied=new Set(EXPECTED.clients);
  clients.extraRequired=info.filter(x=>Number(x.notnull)===1&&!x.dflt_value&&!Number(x.pk)&&!supplied.has(x.name)).map(x=>x.name);
 }
 if(programs?.exists&&!programs.missing.length){
  const info=await tableInfo(db,"programs"), supplied=new Set(EXPECTED.programs);
  programs.extraRequired=info.filter(x=>Number(x.notnull)===1&&!x.dflt_value&&!Number(x.pk)&&!supplied.has(x.name)).map(x=>x.name);
 }
 const ready=Object.values(EXPECTED).every((cols,i)=>{
  const table=Object.keys(EXPECTED)[i],r=report[table];
  return r?.exists&&r.missing.length===0&&(!r.extraRequired||r.extraRequired.length===0);
 });
 return {ready,report};
}
function token(){const b=crypto.getRandomValues(new Uint8Array(32));return [...b].map(x=>x.toString(16).padStart(2,"0")).join("");}
function planFor(goal,days){
 const sessions=[
  {name:"Barbell Back Squat",focus:"Strength",prescription:"3 × 6–8 • RIR 2–3"},
  {name:"Incline Dumbbell Press",focus:"Hypertrophy",prescription:"3 × 8–12 • RIR 2"},
  {name:"Lat Pulldown",focus:"Back",prescription:"3 × 8–12 • controlled"},
  {name:"Hip Mobility Flow",focus:"Mobility",prescription:"6–8 min • comfortable range"}
 ];
 if(goal==="Boxing")sessions.unshift({name:"Shadowboxing",focus:"Boxing",prescription:"4 × 2 min • technical"});
 return {title:(goal||"General Fitness")+" — "+String(days||"3")+" days/week",phase:"Build",sessions};
}
async function clientFromRequest(request,db){
 const auth=request.headers.get("authorization")||"";
 if(!auth.startsWith("Bearer "))return null;
 const access=auth.slice(7).trim();
 if(!access)return null;
 return db.prepare("SELECT * FROM clients WHERE access_token=? LIMIT 1").bind(access).first();
}
export default{
 async fetch(request,env){
  const url=new URL(request.url);
  if(url.pathname==="/api/health"&&request.method==="GET"){
   if(!env.DB)return json({ok:false,database:false,code:"DB_BINDING_MISSING"},503);
   try{
    await env.DB.prepare("SELECT 1 AS ok").first();
    const schema=await inspectSchema(env.DB);
    return json({ok:true,service:"HASSAN Training",database:true,schema_ready:schema.ready,write_enabled:WRITE_ENABLED(env),tables:schema.report});
   }catch(e){return json({ok:false,database:false,code:"DB_READ_FAILED"},503);}
  }
  if(url.pathname==="/api/assessment"&&request.method==="POST"){
   if(!env.DB)return json({ok:false,code:"DB_BINDING_MISSING"},503);
   if(!WRITE_ENABLED(env))return json({ok:false,code:"SAFE_MODE_READ_ONLY",message:"Database writes are locked until the existing schema is verified."},423);
   try{
    const body=await request.json();
    const required=["fullName","phone","goal","experience","days","equipment"];
    for(const key of required)if(!String(body[key]||"").trim())return json({ok:false,code:"VALIDATION_ERROR",field:key},400);
    if(String(body.fullName).length>120||String(body.phone).length>40||String(body.notes||"").length>2000)return json({ok:false,code:"INPUT_TOO_LONG"},400);
    const schema=await inspectSchema(env.DB);
    if(!schema.ready)return json({ok:false,code:"SCHEMA_MISMATCH",schema:schema.report},409);
    const id=crypto.randomUUID(),access=token(),now=new Date().toISOString(),program=planFor(body.goal,body.days);
    const statements=[
     env.DB.prepare("INSERT INTO clients (id,access_token,full_name,phone,goal,experience,training_days,equipment,notes,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(id,access,String(body.fullName).trim(),String(body.phone).trim(),String(body.goal),String(body.experience),String(body.days),String(body.equipment),String(body.notes||""),now),
     env.DB.prepare("INSERT INTO programs (id,client_id,title,phase,content_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").bind(crypto.randomUUID(),id,program.title,program.phase,JSON.stringify(program),now,now)
    ];
    await env.DB.batch(statements);
    return json({ok:true,clientId:id,accessToken:access,program},201);
   }catch(e){return json({ok:false,code:"ASSESSMENT_SAVE_FAILED"},500);}
  }
  if(url.pathname==="/api/me"&&request.method==="GET"){
   if(!env.DB)return json({ok:false,code:"DB_BINDING_MISSING"},503);
   try{
    const client=await clientFromRequest(request,env.DB);if(!client)return json({ok:false,code:"UNAUTHORIZED"},401);
    const program=await env.DB.prepare("SELECT * FROM programs WHERE client_id=? ORDER BY updated_at DESC LIMIT 1").bind(client.id).first();
    const completed=await env.DB.prepare("SELECT COUNT(*) AS n FROM exercise_completions WHERE client_id=?").bind(client.id).first();
    const data=program?JSON.parse(program.content_json):null,sessions=Array.isArray(data?.sessions)?data.sessions:[];
    const completion=Math.min(100,Math.round(Number(completed?.n||0)/Math.max(sessions.length,1)*100));
    return json({clientId:client.id,name:client.full_name,goal:client.goal,phase:program?.phase||"Assessment",completion,session:sessions,program:data});
   }catch(e){return json({ok:false,code:"CLIENT_READ_FAILED"},500);}
  }
  if(url.pathname==="/api/completions"&&request.method==="POST"){
   if(!env.DB)return json({ok:false,code:"DB_BINDING_MISSING"},503);
   if(!WRITE_ENABLED(env))return json({ok:false,code:"SAFE_MODE_READ_ONLY"},423);
   try{
    const client=await clientFromRequest(request,env.DB);if(!client)return json({ok:false,code:"UNAUTHORIZED"},401);
    const body=await request.json(),name=String(body.exerciseName||"").trim();
    if(!name||name.length>160)return json({ok:false,code:"VALIDATION_ERROR"},400);
    const schema=await inspectSchema(env.DB);
    if(!schema.ready)return json({ok:false,code:"SCHEMA_MISMATCH",schema:schema.report},409);
    await env.DB.prepare("INSERT INTO exercise_completions (id,client_id,exercise_name,completed_at) VALUES (?,?,?,?)").bind(crypto.randomUUID(),client.id,name,new Date().toISOString()).run();
    return json({ok:true});
   }catch(e){return json({ok:false,code:"COMPLETION_SAVE_FAILED"},500);}
  }
  if(url.pathname.startsWith("/api/"))return json({ok:false,code:"NOT_FOUND"},404);
  return env.ASSETS.fetch(request);
 }
};