// Actual HTTPS React, model, extraction, citations and assigned proposal materials.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
import { resolve } from 'node:path';
import {spawnSync} from 'node:child_process';
const require=createRequire(import.meta.url);
// shortcut: reuse the installed acceptance browser; configure paths when moving this packet to CI.
const {chromium}=require('C:/Users/PurpleCloud/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root=resolve(import.meta.dirname,'../../..'),origin='https://localhost:8443';
const packet=randomUUID(),output=resolve(root,`.local/resume-p13-agent-browser-${packet}.json`);
const resumePacket=process.argv[2];
if(resumePacket)assert.match(resumePacket,/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
const resume=resumePacket?JSON.parse(await readFile(resolve(root,`.local/resume-p13-agent-browser-${resumePacket}.json`),'utf8')):null;
const resumeRag=!!resume?.regulation_context;
if(resumeRag){assert(resume.checks.actual_cited_manifest_linked_materials_separate_assignee_rejection);assert(resume.checks.reload_preserves_citation_and_manifest);assert(resume.regulation_context.cited_chunk_ids.length);assert.match(resume.failed.message,/\.msg\.agent \.md a/);assert.equal(resume.cleanup_errors.length,0);}
else if(resume){assert.equal(resume.runs.length,2);assert.equal(resume.runs[1].done.proposals.length,1);assert.equal(resume.manifest.files[0].context_state,'used');assert.match(resume.failed.message,/Материалы предложения: 1/);}
const accounts=JSON.parse(await readFile(resolve(root,'.local/p13-deploy-secrets/acceptance-logins.json'),'utf8'));
const proof={packet,requests:[],errors:[],runs:[],chats:[],checks:{},cleanup_errors:[]};
const browser=await chromium.launch({headless:true,executablePath:'C:/Users/PurpleCloud/AppData/Local/ms-playwright/chromium-1208/chrome-win64/chrome.exe'});
const clients=[];
let proposal,primaryError;
async function save(){await writeFile(output,JSON.stringify(proof,null,2));}
async function login(role){
  const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1440,height:900}}),page=await context.newPage();
  const client={context,page,role,tokens:null};clients.push(client);page.setDefaultTimeout(30000);
  page.on('pageerror',e=>proof.errors.push(e.message.slice(0,300)));
  page.on('response',r=>{const path=new URL(r.url()).pathname;if(path.startsWith('/api/v1'))proof.requests.push({role,path,method:r.request().method(),status:r.status()});});
  page.on('response',async r=>{if(new URL(r.url()).pathname==='/api/v1/agent/sessions'&&r.request().method()==='POST'&&r.status()===201){const chat=await r.json();if(!proof.chats.some(x=>x.id===chat.id)){proof.chats.push({id:chat.id,role});await save();}}});
  const account=accounts.find(a=>a.role===role);assert(account);
  await page.goto(origin);await page.getByLabel('Логин',{exact:true}).fill(account.login);await page.getByLabel('Пароль',{exact:true}).fill(account.password);
  const issued=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/auth/login');
  await page.getByRole('button',{name:'Войти',exact:true}).click();client.tokens=await (await issued).json();await page.locator('.avatar-btn').waitFor();
  page.on('response',async r=>{if(new URL(r.url()).pathname==='/api/v1/auth/refresh'&&r.status()===200)client.tokens.access_token=(await r.json()).access_token;});
  await page.locator('.chat .toggle').click();return client;
}
async function api(c,method,path,body,status=200){
  const r=await c.context.request.fetch(origin+'/api/v1/'+path,{method,data:body,headers:{Origin:origin,Authorization:'Bearer '+c.tokens.access_token,'X-CSRF-Token':c.tokens.csrf_token,'Idempotency-Key':randomUUID()}});
  assert.equal(r.status(),status,`${method} ${path}`);return r.status()===204?null:r.json();
}
async function send(c,message){
  const {page}=c,started=Date.now();await page.getByLabel('Сообщение',{exact:true}).fill(message);
  const stream=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/agent/chat/stream'&&r.request().method()==='POST',{timeout:360000});
  await page.getByRole('button',{name:'Отправить',exact:true}).click();const r=await stream;assert.equal(r.status(),200);
  const wire=await r.text();await writeFile(resolve(root,`.local/resume-p13-agent-sse-${packet}-${proof.runs.length+1}.txt`),wire);
  const events=wire.split('\n').filter(s=>s.startsWith('data:')).map(s=>JSON.parse(s.slice(5)));
  const session=events.find(e=>e.session_id&&e.run_id);assert(session);
  if(!proof.chats.some(x=>x.id===session.session_id))proof.chats.push({id:session.session_id,role:c.role});
  const done=events.findLast(e=>e.run_id===session.run_id&&(e.answer!==undefined||e.type));assert(done&&!done.type,'Native model run must finish successfully');
  proof.runs.push({id:session.run_id,chat:session.session_id,seconds:(Date.now()-started)/1000,done});await save();
  await page.locator('.chat.busy').waitFor({state:'detached',timeout:15000});return proof.runs.at(-1);
}
async function newChat(c){await c.page.getByRole('button',{name:'Новый чат',exact:true}).click();}
async function upload(c,path){
  const p=c.page,uploaded=p.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/files'&&r.request().method()==='POST');
  await p.locator('.chat input[type=file]').setInputFiles(path);const r=await uploaded;assert.equal(r.status(),201);const ref=await r.json();
  await p.locator('.composer .thumb.st-ready').waitFor({timeout:120000});return ref;
}
try{
  const admin=await login('admin'),staff=await login('dean_staff');
  const caps=await api(admin,'GET','agent/capabilities');assert(Object.values(caps.services).every(v=>v==='ready'),JSON.stringify(caps.services));
  proof.checks.all_dependencies_and_four_workers_ready=true;
  if(resumeRag){proof.previous_packet=resumePacket;Object.assign(proof.checks,resume.checks);}
  else{
  const work=(await api(staff,'GET','resources/academic_work?sort=work_id&limit=1')).items[0];assert(work);
  const title='P13 SAPPHIRE-742',path=resolve(root,'.local/resume-p13-context.txt');
  const text=`Синтетическое заявление P13. Контрольный код: САПФИР-742 (SAPPHIRE-742).\nУчебная работа №${work.work_id}. Согласованная тема: ${title}.\nОснование: заявление для синтетической проверки материалов P13.\n`;
  let second,secondRef;
  if(resume){second=resume.runs[1];secondRef=resume.second_file;proof.previous_packet=resumePacket;proof.checks.files_only_clarifies_without_proposal=true;}
  else{
  await writeFile(path,text);const ref=await upload(admin,path);proof.file=ref;await save();
  const first=await send(admin,'');assert.equal(first.done.proposals?.length??0,0);assert.match(first.done.answer,/\?|уточните|какую.*задачу/i);
  proof.checks.files_only_clarifies_without_proposal=true;
  await newChat(admin);secondRef=await upload(admin,path);proof.second_file=secondRef;await save();
  second=await send(admin,`Измени только тему существующей учебной работы с системным ID ${work.work_id} на «${title}». Основание: заявление для синтетической проверки материалов P13. Приложенный файл обосновывает предложение: свяжи использованный фрагмент с предложением, назови контрольный код и процитируй источник. Подготовь одно предложение для отдельного решения сотрудника.`);
  }
  assert.equal(second.done.proposals.length,1);proposal=second.done.proposals[0].id;
  const manifest=resume?resume.manifest:await api(admin,'GET',`agent/runs/${second.id}/attachment-context`),file=manifest.files[0];
  assert.equal(file.version_id,secondRef.version_id);assert.equal(file.delivery_state,'acknowledged');assert.equal(file.context_state,'used');assert(file.cited_chunk_ids.length);
  assert.match(second.done.answer,/САПФИР-742|SAPPHIRE-742/);proof.manifest=manifest;
  const current=(await api(staff,'GET',`resources/academic_work?work_id=${work.work_id}`)).items[0];assert.equal(current.topic,work.topic);
  let p=await api(admin,'GET','agent/proposals/'+proposal);assert.equal(p.status,'pending');assert.equal(p.context_files.length,1);assert(p.context_files[0].chunks.length);
  const material=p.context_files[0],download=`files/${material.file_id}/versions/${material.version_id}/download`;
  let dialog;
  if(!resume){
  await admin.page.getByRole('button',{name:'Посмотреть изменение',exact:true}).click();
  dialog=admin.page.getByRole('dialog',{name:'Изменение от агента',exact:true});await dialog.waitFor();
  await dialog.getByText('Материалы предложения: 1',{exact:true}).click();await dialog.locator('.thumb .pic').click();
  const viewer=admin.page.getByRole('dialog',{name:material.filename,exact:true});await viewer.locator('.doc').waitFor();assert.match(await viewer.innerText(),/SAPPHIRE-742/);
  await viewer.getByRole('button',{name:'Закрыть',exact:true}).click();await dialog.getByRole('button',{name:'Позже',exact:true}).click();
  }
  const staffId=(await api(staff,'GET','auth/me')).user_id;
  if(p.routing.assignee_user_id!==staffId)p=await api(admin,'POST',`agent/proposals/${proposal}/assignment`,{assignee_user_id:staffId,reason:'Отдельная проверка материалов P13',expected_version:p.version});
  const protectedFile=await staff.context.request.get(origin+'/api/v1/'+download,{headers:{Authorization:'Bearer '+staff.tokens.access_token}});assert.equal(protectedFile.status(),200);
  assert.equal(createHash('sha256').update(await protectedFile.body()).digest('hex'),createHash('sha256').update(Buffer.from(text)).digest('hex'));
  await staff.page.reload();await staff.page.locator('.avatar-btn').waitFor();if(await staff.page.locator('.chat .toggle').getAttribute('aria-expanded')!=='true')await staff.page.locator('.chat .toggle').click();
  await staff.page.locator('.proposal-queue summary').click();await staff.page.locator('.proposal-queue').getByRole('button',{name:'Обновить',exact:true}).click();
  const card=staff.page.locator('.proposal-queue .proposal-card').filter({hasText:title});await card.getByRole('button',{name:'Открыть',exact:true}).click();
  dialog=staff.page.getByRole('dialog',{name:'Изменение от агента',exact:true});await dialog.getByText('Материалы предложения: 1',{exact:true}).waitFor();
  await dialog.getByLabel('Комментарий к решению (не короче 10 символов)').fill('Отклонено после синтетической проверки материалов P13');
  const decision=staff.page.waitForResponse(r=>new URL(r.url()).pathname===`/api/v1/agent/proposals/${proposal}/decision`);
  await dialog.getByRole('button',{name:'Отклонить',exact:true}).click();assert.equal((await decision).status(),200);
  assert.equal((await api(staff,'GET',`resources/academic_work?work_id=${work.work_id}`)).items[0].topic,work.topic);
  proof.checks.actual_cited_manifest_linked_materials_separate_assignee_rejection=true;
  if(resume){await newChat(admin);await upload(admin,path);const summary=await send(admin,'Назови контрольный код из приложенного заявления и процитируй его точным токеном источника. Не готовь предложения и не меняй данные.');assert.equal(summary.done.proposals.length,0);proof.reload_manifest=await api(admin,'GET',`agent/runs/${summary.id}/attachment-context`);assert.equal(proof.reload_manifest.files[0].context_state,'used');}
  await admin.page.reload();await admin.page.locator('.avatar-btn').waitFor();if(await admin.page.locator('.chat .toggle').getAttribute('aria-expanded')!=='true')await admin.page.locator('.chat .toggle').click();
  assert.match(await admin.page.locator('.messages').innerText(),/SAPPHIRE-742/);proof.checks.reload_preserves_citation_and_manifest=true;
  }
  await newChat(admin);const rag=await send(admin,'Найди действующий синтетический норматив «P13 recovery synthetic regulation». Объясни назначение документа с подтверждённой ссылкой на источник. Не готовь изменения данных.');
  assert.equal(rag.done.proposals.length,0);assert(rag.done.tools_used.includes('search_regulations'));
  const native=spawnSync(resolve(root,'.venv/Scripts/python.exe'),['-B','-c',
    "import json,sys; from uuid import UUID; from backend.tests.integration.p13_https import container; from backend.tests.integration.p13_recovery import sql; print(sql(container('db'), \"SELECT regulation_context FROM agent_backend.agent_run WHERE id='\"+str(UUID(sys.argv[1]))+\"'::uuid\"))",rag.id],{cwd:root,encoding:'utf8',maxBuffer:1024*1024});
  assert.equal(native.status,0,native.stderr.slice(-500));const regulationContext=JSON.parse(native.stdout);
  assert(regulationContext.cited_chunk_ids.length);assert.equal(regulationContext.delivery_state,'acknowledged');
  const fixture=JSON.parse(await readFile(resolve(root,'.local/p13-deploy-fixture-progress.json'),'utf8'));
  assert(regulationContext.chunks.every(c=>c.version_id===fixture.readable_knowledge.import.version_id));
  assert(regulationContext.cited_chunk_ids.every(id=>regulationContext.chunks.some(c=>c.chunk_id===id)));proof.regulation_context=regulationContext;
  // This local synthetic source has no external URL; a verified version/locator is its citation.
  const rendered=await admin.page.locator('.msg.agent .md').last().innerText();
  assert.match(rendered,/P13 recovery synthetic regulation/);assert.match(rendered,/версия p13-restore-v2/);assert.match(rendered,/фрагмент 1/);assert(!rendered.includes('Источник не подтверждён'));
  proof.checks.actual_bge_qdrant_normative_citation=true;assert.equal(proof.errors.length,0);proof.passed=true;
}catch(e){primaryError=e;proof.failed={name:e.name,message:e.message.slice(0,1000)};}
finally{
  const admin=clients.find(c=>c.role==='admin');
  if(proposal&&admin){try{const p=await api(admin,'GET','agent/proposals/'+proposal);if(p.status==='pending'){const staff=clients.find(c=>c.role==='dean_staff');const decisionClient=staff&&p.routing.assignee_user_id===(await api(staff,'GET','auth/me')).user_id?staff:admin;await api(decisionClient,'POST',`agent/proposals/${proposal}/decision`,{approve:false,reason:'Завершение синтетической проверки P13',expected_version:p.version});}}catch(e){proof.cleanup_errors.push('proposal '+e.message.slice(0,100));}}
  for(const chat of proof.chats){const c=clients.find(c=>c.role===chat.role);try{const s=await api(c,'GET','agent/sessions/'+chat.id);if(s.activeRunId)await api(c,'POST',`agent/runs/${s.activeRunId}/cancel`,{});await api(c,'DELETE','agent/sessions/'+chat.id,undefined,204);}catch(e){proof.cleanup_errors.push('chat '+e.message.slice(0,100));}}
  for(const c of clients){try{await api(c,'POST','auth/logout',undefined,204);}catch(e){proof.cleanup_errors.push('logout '+e.message.slice(0,100));}await c.context.close();}
  await browser.close();await save();
}
console.log(JSON.stringify({packet,passed:proof.passed??false,checks:proof.checks,runs:proof.runs.length,requests:proof.requests.length,errors:proof.errors.length,cleanup_errors:proof.cleanup_errors}));
if(primaryError||proof.cleanup_errors.length)process.exitCode=1;
