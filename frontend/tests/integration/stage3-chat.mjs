// I168: actual React/server transport checks. No worker, model, or HTTP response stub.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

export async function stage3Chat({browser,root,origin,evidence,watch,authenticate,loggedIn,responseFor}) {
  assert.equal(process.env.P12_STAGE3_RESOURCE_GO,'1','Stage3 runtime waits for root resource GO');
  const fixture=JSON.parse(await readFile(resolve(root,'.local/p12-browser-credentials.json'),'utf8'));
  assert.equal(fixture.database,'deanery_p12_ui_92004917');assert.equal(fixture.head,'0039_scope_check_latency');
  const account=fixture.accounts.find(account=>account.role==='admin');assert(account);
  const packet=randomUUID(),manifest=resolve(root,`.local/p12-browser-stage3-${packet}.json`);
  const native=(action,extra={})=>{
    const result=spawnSync(resolve(root,'.venv/Scripts/python.exe'),[resolve(root,'frontend/tests/integration/stage3-fixture.py'),action],
      {cwd:root,input:JSON.stringify({manifest,...extra}),encoding:'utf8',maxBuffer:1024*1024});
    assert.equal(result.status,0,(result.stderr||'Native Stage3 control failed').slice(-1200));
    return JSON.parse(result.stdout);
  };
  evidence.database=fixture.database;evidence.chat={packet,fixture_kind:'actual HTTP text transport; model worker stopped',provider_calls:0,
    inventory:native('inventory'),stream_attempts:[],replay_requests:[],cleanup_errors:[]};
  let owned=JSON.parse(await readFile(manifest,'utf8'));
  const retain=async()=>writeFile(manifest,JSON.stringify(owned,null,2));
  const contexts=[],logins=[];let firstEvent=null,initialBody=null,initialKey=null,createKey=null,primaryError=null;
  const message=`P12 transport ${packet}: controlled transport fixture, no model call`;
  const meta=()=>({chat_id:firstEvent.session_id,run_id:firstEvent.run_id,key:initialKey,create_key:createKey,message});
  const headers=login=>({Origin:origin,Authorization:`Bearer ${login.access_token}`,'X-CSRF-Token':login.csrf_token});
  const open=async page=>{if(await page.locator('.chat .toggle').getAttribute('aria-expanded')!=='true')await page.locator('.chat .toggle').click();};
  const sidebar=(page,title)=>page.locator('.cl-item').filter({has:page.locator(`.cl-open[title="${title}"]`)});
  const rename=async(page,from,to)=>{
    await sidebar(page,from).getByRole('button',{name:'Переименовать',exact:true}).click();
    const input=page.locator('.cl-item.editing input');await input.fill(to);
    const response=page.waitForResponse(r=>new URL(r.url()).pathname===`/api/v1/agent/sessions/${firstEvent.session_id}`&&r.request().method()==='PATCH');
    await input.press('Enter');assert.equal((await response).status(),200);await sidebar(page,to).waitFor();
  };
  const remove=async(page,title,status)=>{
    await sidebar(page,title).getByRole('button',{name:'Удалить',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'Удалить чат?',exact:true});await dialog.waitFor();
    const response=page.waitForResponse(r=>new URL(r.url()).pathname===`/api/v1/agent/sessions/${firstEvent.session_id}`&&r.request().method()==='DELETE');
    await dialog.getByRole('button',{name:'Удалить',exact:true}).click();const actual=await response;assert.equal(actual.status(),status);
    if(status!==204)assert.equal((await actual.json()).error.code,'session_busy');
  };
  try {
    for(let client=0;client<2;client++){
      const context=await browser.newContext({viewport:{width:1440,height:900}});contexts.push(context);
      const page=await context.newPage();watch(page,`chat-client-${client+1}`);await page.goto(origin);
      logins.push(await authenticate(page,account));await open(page);
    }
    const [page,second]=await Promise.all(contexts.map(context=>context.pages()[0]));
    page.on('request',request=>{
      const url=new URL(request.url());
      if(url.pathname===`/api/v1/agent/runs/${firstEvent?.run_id}/events`)evidence.chat.replay_requests.push({client:1,after:Number(url.searchParams.get('after'))});
    });
    second.on('request',request=>{
      const url=new URL(request.url());
      if(url.pathname===`/api/v1/agent/runs/${firstEvent?.run_id}/events`)evidence.chat.replay_requests.push({client:2,after:Number(url.searchParams.get('after'))});
    });
    // Forward the first real send unchanged, consume a real committed SSE frame,
    // then lose it before Chrome receives it. Subsequent sends use the normal proxy.
    await page.route('**/api/v1/agent/chat/stream',async route=>{
      const request=route.request(),body=request.postData(),all=await request.allHeaders();
      const key=all['idempotency-key'];assert(body&&key);evidence.chat.stream_attempts.push({key,body});
      if(initialKey){assert.equal(key,initialKey);assert.equal(body,initialBody);await route.continue();return;}
      initialKey=key;initialBody=body;assert.equal(JSON.parse(body).message,message);
      owned.chats=[JSON.parse(body).session_id];await retain();
      const forwardedHeaders={...all};delete forwardedHeaders.host;delete forwardedHeaders['content-length'];
      const response=await fetch('http://127.0.0.1:8881/api/v1/agent/chat/stream',{method:'POST',headers:forwardedHeaders,body,signal:AbortSignal.timeout(10000)});
      assert.equal(response.status,200);assert(response.body);
      const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
      try{
        while(!firstEvent){const next=await reader.read();assert(!next.done,'Actual stream ended before session frame');buffer+=decoder.decode(next.value,{stream:true});
          let boundary;while((boundary=/\r?\n\r?\n/.exec(buffer))){const block=buffer.slice(0,boundary.index);buffer=buffer.slice(boundary.index+boundary[0].length);
            if(block.split(/\r?\n/).includes('event: session')){const line=block.split(/\r?\n/).find(line=>line.startsWith('data:'));assert(line);firstEvent=JSON.parse(line.slice(5));}
          }
        }
      }finally{await reader.cancel();reader.releaseLock();}
      assert.equal(firstEvent.session_id,JSON.parse(body).session_id);
      owned.chats=[firstEvent.session_id];owned.runs=[firstEvent.run_id];await retain();
      evidence.chat.loss_after_commit={session_id:firstEvent.session_id,run_id:firstEvent.run_id,actual_status:200,client_fault:'connection aborted after genuine first session frame'};
      await route.abort('connectionreset');
    });
    await page.getByRole('button',{name:'Новый чат',exact:true}).click();
    await page.getByRole('textbox',{name:'Сообщение',exact:true}).fill(message);
    const created=page.waitForResponse(responseFor('/agent/sessions',201));
    await page.getByRole('textbox',{name:'Сообщение',exact:true}).press('Enter');
    const createdResponse=await created,chat=await createdResponse.json();createKey=(await createdResponse.request().allHeaders())['idempotency-key'];assert(createKey);
    owned.chats=[chat.id];await retain();
    await page.waitForFunction(()=>{const key=Object.keys(sessionStorage).find(key=>key.startsWith('deanery.chat.pending.'));
      return key&&JSON.parse(sessionStorage.getItem(key)).some(item=>item.runId&&item.after>=1);});
    assert(firstEvent);assert.equal(chat.id,firstEvent.session_id);assert.equal(evidence.chat.stream_attempts.length,2);
    assert.deepEqual(evidence.chat.stream_attempts[0],evidence.chat.stream_attempts[1]);
    await page.locator('.msg.user .bubble').filter({hasText:message}).waitFor();assert.equal(await page.locator('.msg.user').count(),1);
    assert(await page.getByRole('button',{name:'Остановить',exact:true}).isEnabled());
    evidence.chat.before_reload=native('chat',meta());
    const pending=await page.evaluate(()=>JSON.parse(sessionStorage.getItem(Object.keys(sessionStorage).find(key=>key.startsWith('deanery.chat.pending.')))));
    assert.equal(pending.length,1);assert.equal(pending[0].key,initialKey);assert.equal(pending[0].runId,firstEvent.run_id);assert.equal(pending[0].after,1);
    await page.unroute('**/api/v1/agent/chat/stream');
    const replay=page.waitForRequest(request=>new URL(request.url()).pathname===`/api/v1/agent/runs/${firstEvent.run_id}/events`);
    await page.reload();await loggedIn(page);await open(page);assert.equal(new URL((await replay).url()).searchParams.get('after'),'1');
    await page.locator('.msg.user .bubble').filter({hasText:message}).waitFor();assert.equal(await page.locator('.msg.user').count(),1);
    evidence.chat.after_reload=native('chat',meta());
    await second.reload();await loggedIn(second);await open(second);await sidebar(second,chat.title).waitFor();
    await sidebar(second,chat.title).locator('.cl-open').click();await second.locator('.msg.user .bubble').filter({hasText:message}).waitFor();
    assert(await second.getByRole('button',{name:'Остановить',exact:true}).isEnabled());
    const draftA=`P12 draft A ${packet}`,draftB=`P12 draft B ${packet}`;
    await page.getByRole('textbox',{name:'Сообщение',exact:true}).fill(draftA);
    await page.getByRole('button',{name:'Новый чат',exact:true}).click();await page.getByRole('textbox',{name:'Сообщение',exact:true}).fill(draftB);
    await sidebar(page,chat.title).locator('.cl-open').click();await page.locator('.chat-head .who small').filter({hasText:chat.title}).waitFor();
    await page.waitForFunction(value=>document.querySelector('textarea[aria-label="Сообщение"]')?.value===value,draftA);
    assert.equal(await page.getByRole('textbox',{name:'Сообщение',exact:true}).inputValue(),draftA);
    await page.getByRole('button',{name:'Новый чат',exact:true}).click();assert.equal(await page.getByRole('textbox',{name:'Сообщение',exact:true}).inputValue(),draftB);
    await sidebar(page,chat.title).locator('.cl-open').click();await page.locator('.chat-head .who small').filter({hasText:chat.title}).waitFor();evidence.chat.local_drafts=true;
    const titleA=`P12 server A ${packet}`,titleB=`P12 server B ${packet}`;
    await rename(page,chat.title,titleA);await second.reload();await loggedIn(second);await open(second);await sidebar(second,titleA).waitFor();
    await rename(second,titleA,titleB);await page.reload();await loggedIn(page);await open(page);await sidebar(page,titleB).waitFor();
    await page.locator('.chat-head .who small').filter({hasText:titleB}).waitFor();
    evidence.chat.two_clients={same_chat:true,last_saved_title:true};
    for(const [body,key,code]of [[{...JSON.parse(initialBody),message:message+' changed'},initialKey,'idempotency_conflict'],[JSON.parse(initialBody),randomUUID(),'session_busy']]){
      const response=await contexts[0].request.post(`${origin}/api/v1/agent/chat/stream`,{headers:{...headers(logins[0]),'Idempotency-Key':key},data:body,timeout:10000});
      assert.equal(response.status(),409);assert.equal((await response.json()).error.code,code);
    }
    await remove(page,titleB,409);await page.getByRole('alert').filter({hasText:'Сначала остановите агента'}).waitFor();
    const cancelled=page.waitForResponse(responseFor(`/agent/runs/${firstEvent.run_id}/cancel`,202));
    await page.getByRole('button',{name:'Остановить',exact:true}).click();assert.equal((await cancelled).status(),202);
    await page.locator('.msg.agent.error').filter({hasText:'Запуск остановлен'}).waitFor();
    await page.waitForFunction(()=>!Object.keys(sessionStorage).some(key=>key.startsWith('deanery.chat.pending.')));
    assert.equal(await page.locator('.msg.user').count(),1);assert.equal(await page.locator('.msg.agent.error').count(),1);
    const pages=[];
    for(const offset of [0,1]){const response=await contexts[0].request.get(`${origin}/api/v1/agent/sessions/${firstEvent.session_id}/messages?limit=1&offset=${offset}`,{headers:headers(logins[0])});
      assert.equal(response.status(),200);pages.push(await response.json());}
    assert.equal(pages[0].has_more,true);assert.equal(pages[1].has_more,false);assert.deepEqual(pages.flatMap(page=>page.items.map(item=>item.role)),['user','error']);
    assert.notEqual(pages[0].items[0].id,pages[1].items[0].id);evidence.chat.server_message_pagination=true;
    await remove(page,titleB,204);await second.reload();await loggedIn(second);await open(second);
    assert.equal(await sidebar(second,titleB).count(),0);evidence.chat.deleted=native('deleted',meta());
  } catch(error) {
    primaryError=error;evidence.chat.primary_failure=error.message.slice(0,700);throw error;
  } finally {
    // Cleanup only IDs recorded from actual requests. Never revoke pre-existing sessions.
    await retain();
    for(const chat of owned.chats){
      try{
        if(logins[0]){
          const current=await contexts[0].request.get(`${origin}/api/v1/agent/sessions/${chat}`,{headers:headers(logins[0]),timeout:10000});assert([200,404].includes(current.status()));
          if(current.status()===200){const active=(await current.json()).activeRunId;
            if(active){const response=await contexts[0].request.post(`${origin}/api/v1/agent/runs/${active}/cancel`,{data:{},headers:headers(logins[0]),timeout:10000});assert([200,202].includes(response.status()));}}
        }
        if(logins[0]){const response=await contexts[0].request.delete(`${origin}/api/v1/agent/sessions/${chat}`,{headers:headers(logins[0]),timeout:10000});assert([204,404].includes(response.status()));}
      }catch(error){evidence.chat.cleanup_errors.push(error.message.slice(0,300));}
    }
    for(let index=0;index<contexts.length;index++){
      try{if(logins[index])assert.equal((await contexts[index].request.post(`${origin}/api/v1/auth/logout`,{headers:headers(logins[index])})).status(),204);}
      catch(error){evidence.chat.cleanup_errors.push(error.message.slice(0,300));}
      finally{await contexts[index].close();}
    }
    try{evidence.chat.cleanup=native('cleanup');}catch(error){evidence.chat.cleanup_errors.push(error.message.slice(0,400));}
    if(!primaryError)assert.equal(evidence.chat.cleanup_errors.length,0,JSON.stringify(evidence.chat.cleanup_errors));
  }
}

// I181: continue only the unverified tail; do not repeat the committed-loss/replay proof.
export async function stage3ChatContinue({browser,root,origin,evidence,watch,authenticate,loggedIn,responseFor}) {
  assert.equal(process.env.P12_STAGE3_RESOURCE_GO,'1');
  const previous=JSON.parse(await readFile(resolve(root,'.nelson/missions/2026-10-11_065347_b2445e93/task16-browser-stage3-chat-first-failure.json'),'utf8'));
  const manifest=resolve(root,`.local/p12-browser-stage3-${previous.chat.packet}.json`),packet=randomUUID();
  const native=(action,extra={})=>{
    const result=spawnSync(resolve(root,'.venv/Scripts/python.exe'),[resolve(root,'frontend/tests/integration/stage3-fixture.py'),action],
      {cwd:root,input:JSON.stringify({manifest,...extra}),encoding:'utf8',maxBuffer:1024*1024});
    assert.equal(result.status,0,(result.stderr||'Native continuation control failed').slice(-1200));return JSON.parse(result.stdout);
  };
  const plan=native('continuation'),credentials=JSON.parse(await readFile(resolve(root,'.local/p12-browser-credentials.json'),'utf8'));
  const account=credentials.accounts.find(account=>account.role==='admin');assert(account);
  evidence.database=credentials.database;evidence.continuation={packet,previous_packet:previous.chat.packet,provider_calls:0,cleanup_errors:[],draft_network:[]};
  const contexts=[],logins=[];let release=()=>{},tracing=false,primaryError=null,newRun=null;
  const trace=resolve(root,`.local/p12-browser-stage3-draft-${packet}.zip`);
  const headers=login=>({Origin:origin,Authorization:`Bearer ${login.access_token}`,'X-CSRF-Token':login.csrf_token});
  const expanded=async page=>{if(await page.locator('.chat .toggle').getAttribute('aria-expanded')!=='true')await page.locator('.chat .toggle').click();};
  const sidebar=(page,title)=>page.locator('.cl-item').filter({has:page.locator(`.cl-open[title="${title}"]`)});
  const snapshot=page=>page.evaluate(()=>({caption:document.querySelector('.chat-head .who small')?.textContent,
    selectedChat:Object.keys(sessionStorage).filter(key=>key.startsWith('deanery.chat.active.')).map(key=>sessionStorage.getItem(key)),
    text:document.querySelector('textarea[aria-label="Сообщение"]')?.value}));
  const select=async(page,title)=>{await sidebar(page,title).locator('.cl-open').click();await page.locator('.chat-head .who small').filter({hasText:title}).waitFor();};
  const rename=async(page,from,to)=>{
    await sidebar(page,from).getByRole('button',{name:'Переименовать',exact:true}).click();await page.locator('.cl-item.editing input').fill(to);
    const response=page.waitForResponse(r=>new URL(r.url()).pathname===`/api/v1/agent/sessions/${plan.chat_id}`&&r.request().method()==='PATCH');
    await page.locator('.cl-item.editing input').press('Enter');assert.equal((await response).status(),200);await sidebar(page,to).waitFor();
  };
  const remove=async(page,title,status)=>{
    await sidebar(page,title).getByRole('button',{name:'Удалить',exact:true}).click();
    const response=page.waitForResponse(r=>new URL(r.url()).pathname===`/api/v1/agent/sessions/${plan.chat_id}`&&r.request().method()==='DELETE');
    await page.getByRole('dialog',{name:'Удалить чат?',exact:true}).getByRole('button',{name:'Удалить',exact:true}).click();
    const actual=await response;assert.equal(actual.status(),status);if(status===409)assert.equal((await actual.json()).error.code,'session_busy');
  };
  try {
    const context=await browser.newContext({viewport:{width:1440,height:900}});contexts.push(context);
    const page=await context.newPage();watch(page,'continuation-first');await page.goto(origin);logins.push(await authenticate(page,account));await expanded(page);
    await context.tracing.start({screenshots:true,snapshots:true,sources:false});tracing=true;
    await select(page,plan.title);await page.locator('.msg.user .bubble').filter({hasText:plan.message}).waitFor();
    const draftA=`P12 retained A ${packet}`,draftB=`P12 retained B ${packet}`;
    await page.getByRole('textbox',{name:'Сообщение',exact:true}).fill(draftA);await page.getByRole('button',{name:'Новый чат',exact:true}).click();
    await page.getByRole('textbox',{name:'Сообщение',exact:true}).fill(draftB);
    let reached,failed;const observed=new Promise((resolve,reject)=>{reached=resolve;failed=reject;}),held=new Promise(resolve=>{release=resolve;});
    const timeout=setTimeout(()=>failed(new Error('Real chat-message GET did not reach the draft timing gate')),15000);
    await page.route(`**/api/v1/agent/sessions/${plan.chat_id}/messages?*`,async route=>{
      try{const actual=await route.fetch();assert.equal(actual.status(),200);evidence.continuation.draft_network.push({event:'server GET completed; delivery held',status:200});
        reached();await held;await route.fulfill({response:actual});}
      catch(error){failed(error);await route.abort().catch(()=>{});}
    });
    await Promise.all([sidebar(page,plan.title).locator('.cl-open').click(),observed]).finally(()=>clearTimeout(timeout));
    evidence.continuation.before_get_delivery=await snapshot(page);
    assert.equal(evidence.continuation.before_get_delivery.caption,'Новый чат');assert.equal(evidence.continuation.before_get_delivery.text,draftB);
    assert.deepEqual(evidence.continuation.before_get_delivery.selectedChat,[]);
    release();await page.locator('.chat-head .who small').filter({hasText:plan.title}).waitFor();
    await page.waitForFunction(value=>document.querySelector('textarea[aria-label="Сообщение"]')?.value===value,draftA);
    evidence.continuation.after_get_delivery=await snapshot(page);
    assert.equal(evidence.continuation.after_get_delivery.text,draftA);assert.deepEqual(evidence.continuation.after_get_delivery.selectedChat,[plan.chat_id]);
    await page.unroute(`**/api/v1/agent/sessions/${plan.chat_id}/messages?*`);
    await page.getByRole('button',{name:'Новый чат',exact:true}).click();assert.equal(await page.getByRole('textbox',{name:'Сообщение',exact:true}).inputValue(),draftB);
    await select(page,plan.title);assert.equal(await page.getByRole('textbox',{name:'Сообщение',exact:true}).inputValue(),draftA);
    await context.tracing.stop({path:trace});tracing=false;evidence.continuation.private_draft_trace=trace;
    evidence.continuation.draft_result='native server completion precedes React chat/draft switch; wait for selected-chat identity';
    const secondContext=await browser.newContext({viewport:{width:1440,height:900}});contexts.push(secondContext);
    const second=await secondContext.newPage();watch(second,'continuation-second');await second.goto(origin);logins.push(await authenticate(second,account));await expanded(second);
    const titleA=`P12 last A ${packet}`,titleB=`P12 last B ${packet}`;
    await rename(page,plan.title,titleA);await second.reload();await loggedIn(second);await expanded(second);await sidebar(second,titleA).waitFor();
    await rename(second,titleA,titleB);await page.reload();await loggedIn(page);await expanded(page);await sidebar(page,titleB).waitFor();
    await page.locator('.chat-head .who small').filter({hasText:titleB}).waitFor();
    assert.equal((await snapshot(page)).caption,titleB);evidence.continuation.server_rename={two_clients:true,last_saved_title:true};
    // A fresh queued run is necessary for the unverified active-delete/Stop gates.
    const message=`P12 continuation ${packet}: controlled active Stop fixture, no model call`;
    const requested=page.waitForRequest(request=>new URL(request.url()).pathname==='/api/v1/agent/chat/stream'&&request.method()==='POST');
    await page.getByRole('textbox',{name:'Сообщение',exact:true}).fill(message);await page.getByRole('button',{name:'Отправить',exact:true}).click();
    const request=await requested,key=(await request.allHeaders())['idempotency-key'],body=request.postData();
    await page.waitForFunction(()=>{const key=Object.keys(sessionStorage).find(key=>key.startsWith('deanery.chat.pending.'));
      return key&&JSON.parse(sessionStorage.getItem(key)).some(item=>item.runId&&item.after===1);});
    const pending=await page.evaluate(()=>JSON.parse(sessionStorage.getItem(Object.keys(sessionStorage).find(key=>key.startsWith('deanery.chat.pending.')))));
    assert.equal(pending.length,1);assert.equal(pending[0].key,key);assert.equal(pending[0].chatId,plan.chat_id);
    newRun={chat_id:plan.chat_id,run_id:pending[0].runId,key,create_key:plan.create_key,message};
    const manifestData=JSON.parse(await readFile(manifest,'utf8'));assert(!manifestData.runs.includes(newRun.run_id));manifestData.runs.push(newRun.run_id);
    await writeFile(manifest,JSON.stringify(manifestData,null,2));evidence.continuation.new_run=newRun.run_id;
    for(const [changed,attempt,code]of [[{...JSON.parse(body),message:message+' changed'},key,'idempotency_conflict'],[JSON.parse(body),randomUUID(),'session_busy']]){
      const result=await context.request.post(`${origin}/api/v1/agent/chat/stream`,{headers:{...headers(logins[0]),'Idempotency-Key':attempt},data:changed,timeout:10000});
      assert.equal(result.status(),409);assert.equal((await result.json()).error.code,code);
    }
    evidence.continuation.send_denials={same_key_changed_body:409,new_key_busy_chat:409};
    await remove(page,titleB,409);await page.getByRole('alert').filter({hasText:'Сначала остановите агента'}).waitFor();
    const cancelled=page.waitForResponse(responseFor(`/agent/runs/${newRun.run_id}/cancel`,202));
    await page.getByRole('button',{name:'Остановить',exact:true}).click();const cancelledResponse=await cancelled;
    assert.equal((await cancelledResponse.json()).stop_requested,true);
    await page.waitForFunction(()=>!Object.keys(sessionStorage).some(key=>key.startsWith('deanery.chat.pending.')));
    assert.equal(await page.locator('.msg.user').count(),2);assert.equal(await page.locator('.msg.agent.error').count(),2);
    evidence.continuation.terminal=native('terminal',newRun);
    const pages=[];
    for(const offset of [0,1,2,3]){const response=await context.request.get(`${origin}/api/v1/agent/sessions/${plan.chat_id}/messages?limit=1&offset=${offset}`,{headers:headers(logins[0])});
      assert.equal(response.status(),200);pages.push(await response.json());}
    assert.deepEqual(pages.map(page=>page.has_more),[true,true,true,false]);assert.deepEqual(pages.flatMap(page=>page.items.map(item=>item.role)),['user','error','user','error']);
    assert.equal(new Set(pages.flatMap(page=>page.items.map(item=>item.id))).size,4);evidence.continuation.server_message_pagination=true;
    await remove(page,titleB,204);await second.reload();await loggedIn(second);await expanded(second);assert.equal(await sidebar(second,titleB).count(),0);
    evidence.continuation.deleted=[native('deleted',plan),native('deleted',newRun)];
  }catch(error){
    primaryError=error;evidence.continuation.primary_failure=error.message.slice(0,1000);throw error;
  }finally{
    release();if(tracing&&contexts[0]){await contexts[0].tracing.stop({path:trace}).catch(()=>{});evidence.continuation.private_draft_trace=trace;}
    if(logins[0])try{
      const context=contexts[0],current=await context.request.get(`${origin}/api/v1/agent/sessions/${plan.chat_id}`,{headers:headers(logins[0]),timeout:10000});assert([200,404].includes(current.status()));
      if(current.status()===200){const active=(await current.json()).activeRunId;
        if(active){const result=await context.request.post(`${origin}/api/v1/agent/runs/${active}/cancel`,{headers:headers(logins[0]),data:{},timeout:10000});assert([200,202].includes(result.status()));}}
      const removed=await context.request.delete(`${origin}/api/v1/agent/sessions/${plan.chat_id}`,{headers:headers(logins[0]),timeout:10000});assert([204,404].includes(removed.status()));
    }catch(error){evidence.continuation.cleanup_errors.push(error.message.slice(0,400));}
    for(let index=0;index<contexts.length;index++){
      try{if(logins[index])assert.equal((await contexts[index].request.post(`${origin}/api/v1/auth/logout`,{headers:headers(logins[index])})).status(),204);}
      catch(error){evidence.continuation.cleanup_errors.push(error.message.slice(0,400));}
      finally{await contexts[index].close();}
    }
    try{evidence.continuation.cleanup=native('cleanup');}catch(error){evidence.continuation.cleanup_errors.push(error.message.slice(0,500));}
    if(!primaryError)assert.equal(evidence.continuation.cleanup_errors.length,0,JSON.stringify(evidence.continuation.cleanup_errors));
  }
}

// I182: one fresh chat/run for the remaining active-delete and native Stop gates.
export async function stage3ChatTail({browser,root,origin,evidence,watch,authenticate,loggedIn,responseFor}) {
  assert.equal(process.env.P12_STAGE3_RESOURCE_GO,'1');
  const credentials=JSON.parse(await readFile(resolve(root,'.local/p12-browser-credentials.json'),'utf8'));
  const account=credentials.accounts.find(account=>account.role==='admin'),packet=randomUUID();assert(account);
  const manifest=resolve(root,`.local/p12-browser-stage3-tail-${packet}.json`),trace=resolve(root,`.local/p12-browser-stage3-tail-${packet}.zip`);
  const native=(action,extra={})=>{
    const result=spawnSync(resolve(root,'.venv/Scripts/python.exe'),[resolve(root,'frontend/tests/integration/stage3-fixture.py'),action],
      {cwd:root,input:JSON.stringify({manifest,...extra}),encoding:'utf8',maxBuffer:1024*1024});
    assert.equal(result.status,0,(result.stderr||'Native remaining-tail control failed').slice(-1200));return JSON.parse(result.stdout);
  };
  evidence.database=credentials.database;evidence.tail={packet,provider_calls:0,inventory:native('inventory'),cleanup_errors:[]};
  let owned=JSON.parse(await readFile(manifest,'utf8')),chat=null,run=null,tracing=false,primaryError=null;
  const contexts=[],logins=[],headers=index=>({Origin:origin,Authorization:`Bearer ${logins[index].access_token}`,'X-CSRF-Token':logins[index].csrf_token});
  const retained=()=>writeFile(manifest,JSON.stringify(owned,null,2));
  const expanded=async page=>{if(await page.locator('.chat .toggle').getAttribute('aria-expanded')!=='true')await page.locator('.chat .toggle').click();};
  const sidebar=(page,title)=>page.locator('.cl-item').filter({has:page.locator(`.cl-open[title="${title}"]`)});
  const remove=async(page,status)=>{
    await sidebar(page,chat.title).getByRole('button',{name:'Удалить',exact:true}).click();
    const response=page.waitForResponse(r=>new URL(r.url()).pathname===`/api/v1/agent/sessions/${chat.id}`&&r.request().method()==='DELETE');
    await page.getByRole('dialog',{name:'Удалить чат?',exact:true}).getByRole('button',{name:'Удалить',exact:true}).click();
    const actual=await response;assert.equal(actual.status(),status);if(status===409)assert.equal((await actual.json()).error.code,'session_busy');
  };
  try{
    const context=await browser.newContext({viewport:{width:1440,height:900}});contexts.push(context);
    const page=await context.newPage();watch(page,'tail-first');await page.goto(origin);logins.push(await authenticate(page,account));await expanded(page);
    await context.tracing.start({screenshots:true,snapshots:true,sources:false});tracing=true;
    const message=`P12 active tail ${packet}: controlled transport fixture, no model call`;
    await page.getByRole('button',{name:'Новый чат',exact:true}).click();await page.getByRole('textbox',{name:'Сообщение',exact:true}).fill(message);
    const created=page.waitForResponse(responseFor('/agent/sessions',201));
    const sending=page.waitForRequest(request=>new URL(request.url()).pathname==='/api/v1/agent/chat/stream'&&request.method()==='POST');
    await page.getByRole('button',{name:'Отправить',exact:true}).click();
    const creation=await created;chat=await creation.json();owned.chats=[chat.id];await retained();
    const createKey=(await creation.request().allHeaders())['idempotency-key'],request=await sending;
    const key=(await request.allHeaders())['idempotency-key'],body=request.postData();assert(createKey&&key&&body);
    await page.waitForFunction(({id,message})=>{
      const key=Object.keys(sessionStorage).find(key=>key.startsWith('deanery.chat.pending.'));
      const pending=key?JSON.parse(sessionStorage.getItem(key)):[];
      return pending.length===1&&pending[0].chatId===id&&pending[0].runId&&pending[0].after===1
        && Object.keys(sessionStorage).some(key=>key.startsWith('deanery.chat.active.')&&sessionStorage.getItem(key)===id)
        && document.querySelector('.msg.user .bubble')?.textContent===message;
    },{id:chat.id,message});
    await page.locator('.chat-head .who small').filter({hasText:chat.title}).waitFor();
    const pending=await page.evaluate(()=>JSON.parse(sessionStorage.getItem(Object.keys(sessionStorage).find(key=>key.startsWith('deanery.chat.pending.')))));
    assert.equal(pending[0].key,key);run={chat_id:chat.id,run_id:pending[0].runId,key,create_key:createKey,message};owned.runs=[run.run_id];await retained();
    evidence.tail.queued=native('chat',run);evidence.tail.selected_chat={id:chat.id,caption:await page.locator('.chat-head .who small').textContent(),user_messages:1};
    const secondContext=await browser.newContext({viewport:{width:1440,height:900}});contexts.push(secondContext);
    const second=await secondContext.newPage();watch(second,'tail-second');await second.goto(origin);logins.push(await authenticate(second,account));await expanded(second);await sidebar(second,chat.title).waitFor();
    // The first client's list refreshes at terminal. The second client already read
    // the real new chat and can test active Delete without replaying the run.
    await remove(second,409);await second.getByRole('alert').filter({hasText:'Сначала остановите агента'}).waitFor();
    evidence.tail.active_delete={status:409,message:'Сначала остановите агента'};
    for(const [changed,attempt,code]of [[{...JSON.parse(body),message:message+' changed'},key,'idempotency_conflict'],[JSON.parse(body),randomUUID(),'session_busy']]){
      const result=await context.request.post(`${origin}/api/v1/agent/chat/stream`,{headers:{...headers(0),'Idempotency-Key':attempt},data:changed,timeout:10000});
      assert.equal(result.status(),409);assert.equal((await result.json()).error.code,code);
    }
    evidence.tail.send_denials={same_key_changed_body:409,new_key_busy_chat:409};
    const stopped=page.waitForResponse(responseFor(`/agent/runs/${run.run_id}/cancel`,202));
    await page.getByRole('button',{name:'Остановить',exact:true}).click();const stopResponse=await stopped;assert.equal((await stopResponse.json()).stop_requested,true);
    await page.locator('.msg.agent.error').filter({hasText:'Запуск остановлен'}).waitFor();
    await page.getByRole('button',{name:'Отправить',exact:true}).waitFor();
    await page.waitForFunction(()=>!Object.keys(sessionStorage).some(key=>key.startsWith('deanery.chat.pending.')));
    assert.equal(await page.locator('.msg.user').count(),1);assert.equal(await page.locator('.msg.agent.error').count(),1);
    evidence.tail.terminal=native('terminal',run);
    const pages=[];for(const offset of [0,1]){
      const response=await context.request.get(`${origin}/api/v1/agent/sessions/${chat.id}/messages?limit=1&offset=${offset}`,{headers:headers(0)});
      assert.equal(response.status(),200);pages.push(await response.json());
    }
    assert.deepEqual(pages.map(page=>page.has_more),[true,false]);assert.deepEqual(pages.flatMap(page=>page.items.map(item=>item.role)),['user','error']);
    assert.notEqual(pages[0].items[0].id,pages[1].items[0].id);evidence.tail.message_pagination={pages:2,canonical_messages:2,unique_ids:true};
    await sidebar(page,chat.title).waitFor();await remove(page,204);evidence.tail.deleted=native('deleted',run);
    const deletedList=second.waitForResponse(responseFor('/agent/sessions'));
    await second.reload();await loggedIn(second);await expanded(second);await deletedList;
    await sidebar(second,chat.title).waitFor({state:'detached'});assert.equal(await sidebar(second,chat.title).count(),0);
    evidence.tail.two_clients_deleted=true;
  }catch(error){primaryError=error;evidence.tail.primary_failure=error.message.slice(0,1000);throw error;}
  finally{
    if(tracing&&contexts[0]){await contexts[0].tracing.stop({path:trace}).catch(()=>{});evidence.tail.private_trace=trace;}
    if(chat&&logins[0])try{
      const context=contexts[0],current=await context.request.get(`${origin}/api/v1/agent/sessions/${chat.id}`,{headers:headers(0),timeout:10000});assert([200,404].includes(current.status()));
      if(current.status()===200){const active=(await current.json()).activeRunId;if(active){const response=await context.request.post(`${origin}/api/v1/agent/runs/${active}/cancel`,{headers:headers(0),data:{},timeout:10000});assert([200,202].includes(response.status()));}}
      assert([204,404].includes((await context.request.delete(`${origin}/api/v1/agent/sessions/${chat.id}`,{headers:headers(0),timeout:10000})).status()));
    }catch(error){evidence.tail.cleanup_errors.push(error.message.slice(0,400));}
    for(let index=0;index<contexts.length;index++){
      try{if(logins[index])assert.equal((await contexts[index].request.post(`${origin}/api/v1/auth/logout`,{headers:headers(index)})).status(),204);}
      catch(error){evidence.tail.cleanup_errors.push(error.message.slice(0,400));}
      finally{await contexts[index].close();}
    }
    try{evidence.tail.cleanup=native('cleanup');}catch(error){evidence.tail.cleanup_errors.push(error.message.slice(0,500));}
    if(!primaryError)assert.equal(evidence.tail.cleanup_errors.length,0,JSON.stringify(evidence.tail.cleanup_errors));
  }
}
