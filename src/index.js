const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json; charset=UTF-8","cache-control":"no-store","x-content-type-options":"nosniff","referrer-policy":"same-origin"}});
const EXPECTED={
 clients:["id","full_name","phone","email","created_at"],
 assessments:["id","client_id","training_goal","experience_level","training_days","equipment_access","notes","created_at"],
 programs:["id","client_id","program_name","description","status","created_at","is_template","template_category"],
 exercise_completions:["id","client_id","exercise_name","completed_at"],
 sessions:["token","user_id","expires_at","created_at"]
};
const WRITE_ENABLED=env=>String(env.ALLOW_DB_WRITES||"false").toLowerCase()==="true";
async function tableInfo(db,name){
 const r=await db.prepare('PRAGMA table_info("'+name.replace(/"/g,"")+'")').all();
 return r.results||[];
}
async function inspectSchema(db){
 const names=await db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
 const set=new Set((names.results||[]).map(x=>x.name)),report={};
 for(const [table,required] of Object.entries(EXPECTED)){
  if(!set.has(table)){report[table]={exists:false,missing:required};continue;}
  const info=await tableInfo(db,table),cols=new Set(info.map(x=>x.name));
  report[table]={exists:true,missing:required.filter(x=>!cols.has(x))};
 }
 return {ready:Object.values(report).every(x=>x.exists&&x.missing.length===0),report};
}
function token(){
 const b=crypto.getRandomValues(new Uint8Array(32));
 return "client_"+[...b].map(x=>x.toString(16).padStart(2,"0")).join("");
}
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
 if(!auth.startsWith("Bearer client_"))return null;
 const access=auth.slice(7).trim();
 if(!/^client_[a-f0-9]{64}$/.test(access))return null;
 return db.prepare("SELECT c.id,c.full_name,c.phone FROM sessions s JOIN clients c ON c.id=s.user_id WHERE s.token=? AND s.expires_at>datetime('now') LIMIT 1").bind(access).first();
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
   if(!WRITE_ENABLED(env))return json({ok:false,code:"SAFE_MODE_READ_ONLY",message:"Database writes remain locked until the preview flow has passed end-to-end tests."},423);
   try{
    const body=await request.json();
    const required=["fullName","phone","goal","experience","days","equipment"];
    for(const key of required)if(!String(body[key]||"").trim())return json({ok:false,code:"VALIDATION_ERROR",field:key},400);
    const fullName=String(body.fullName).trim(),phone=String(body.phone).trim(),notes=String(body.notes||"").trim();
    if(fullName.length>120||phone.length>40||notes.length>2000)return json({ok:false,code:"INPUT_TOO_LONG"},400);
    const days=Math.max(1,Math.min(7,parseInt(String(body.days),10)||3));
    const schema=await inspectSchema(env.DB);
    if(!schema.ready)return json({ok:false,code:"SCHEMA_MISMATCH",schema:schema.report},409);
    const client=await env.DB.prepare("INSERT INTO clients (full_name,phone) VALUES (?,?) RETURNING id").bind(fullName,phone).first();
    if(!client?.id)return json({ok:false,code:"CLIENT_CREATE_FAILED"},500);
    const id=Number(client.id),access=token(),now=new Date().toISOString(),program=planFor(String(body.goal),days);
    const description=JSON.stringify({ ...program, goal:String(body.goal), experience:String(body.experience), equipment:String(body.equipment), trainingDays:days });
    await env.DB.batch([
     env.DB.prepare("INSERT INTO assessments (client_id,training_goal,experience_level,training_days,equipment_access,notes) VALUES (?,?,?,?,?,?)").bind(id,String(body.goal),String(body.experience),days,String(body.equipment),notes),
     env.DB.prepare("INSERT INTO programs (client_id,program_name,description,status,is_template,template_category) VALUES (?,?,?,'active',0,?)").bind(id,program.title,description,String(body.goal)),
     env.DB.prepare("INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,datetime('now','+30 days'))").bind(access,id)
    ]);
    return json({ok:true,clientId:id,accessToken:access,expiresInDays:30,program},201);
   }catch(e){return json({ok:false,code:"ASSESSMENT_SAVE_FAILED"},500);}
  }
  if(url.pathname==="/api/me"&&request.method==="GET"){
   if(!env.DB)return json({ok:false,code:"DB_BINDING_MISSING"},503);
   try{
    const client=await clientFromRequest(request,env.DB);if(!client)return json({ok:false,code:"UNAUTHORIZED"},401);
    const program=await env.DB.prepare("SELECT program_name,description,status,created_at FROM programs WHERE client_id=? AND is_template=0 ORDER BY created_at DESC LIMIT 1").bind(client.id).first();
    const completed=await env.DB.prepare("SELECT COUNT(*) AS n FROM exercise_completions WHERE client_id=?").bind(client.id).first();
    let data=null;try{data=program?.description?JSON.parse(program.description):null;}catch(e){}
    const sessions=Array.isArray(data?.sessions)?data.sessions:[];
    const completion=Math.min(100,Math.round(Number(completed?.n||0)/Math.max(sessions.length,1)*100));
    return json({clientId:client.id,name:client.full_name,goal:data?.goal||"",phase:program?.status||"Assessment",completion,session:sessions,program:data});
   }catch(e){return json({ok:false,code:"CLIENT_READ_FAILED"},500);}
  }
  if(url.pathname==="/api/completions"&&request.method==="POST"){
   if(!env.DB)return json({ok:false,code:"DB_BINDING_MISSING"},503);
   if(!WRITE_ENABLED(env))return json({ok:false,code:"SAFE_MODE_READ_ONLY"},423);
   try{
    const client=await clientFromRequest(request,env.DB);if(!client)return json({ok:false,code:"UNAUTHORIZED"},401);
    const body=await request.json(),name=String(body.exerciseName||"").trim();
    if(!name||name.length>160)return json({ok:false,code:"VALIDATION_ERROR"},400);
    const schema=await inspectSchema(env.DB);if(!schema.ready)return json({ok:false,code:"SCHEMA_MISMATCH"},409);
    await env.DB.prepare("INSERT INTO exercise_completions (client_id,exercise_name) VALUES (?,?)").bind(client.id,name).run();
    return json({ok:true});
   }catch(e){return json({ok:false,code:"COMPLETION_SAVE_FAILED"},500);}
  }
  if(url.pathname.startsWith("/api/"))return json({ok:false,code:"NOT_FOUND"},404);
  return env.ASSETS.fetch(request);
 }
};