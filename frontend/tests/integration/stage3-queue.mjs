// I168: genuine guarded proposal fixtures; native UI decisions, zero provider calls.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

export async function stage3Queue({browser,root,origin,evidence,watch,authenticate,responseFor}) {
  assert.equal(process.env.P12_STAGE3_RESOURCE_GO,'1','Stage3 runtime waits for root resource GO');
  const credentials=JSON.parse(await readFile(resolve(root,'.local/p12-browser-credentials.json'),'utf8'));
  const resumed=process.env.P12_STAGE3_QUEUE_RESUME;
  if(resumed)assert.equal(resumed,'50be4471-2116-4568-9c0b-635a415ff24a');
  const packet=resumed??randomUUID(),manifest=resolve(root,`.local/p12-browser-stage3-queue-${packet}.json`);
  const native=(action,extra={})=>{
    const result=spawnSync(resolve(root,'.venv/Scripts/python.exe'),[resolve(root,'frontend/tests/integration/stage3-fixture.py'),action],
      {cwd:root,input:JSON.stringify({manifest,...extra}),encoding:'utf8',maxBuffer:1024*1024});
    assert.equal(result.status,0,(result.stderr||'Native queue control failed').slice(-1200));return JSON.parse(result.stdout);
  };
  const probe='Яё — проверка обмена Ω',encoding=native('encoding-check',{probe});assert.deepEqual(encoding,{probe,database_access:false});
  const plan=resumed?native('queue-resume'):null;
  evidence.database=credentials.database;evidence.queue={packet,fixture_kind:'actual start/claim/prepare/finish RPC, no model',provider_calls:0,
    resumed_existing_document:!!resumed,encoding_roundtrip:true,inventory:plan?.inventory??native('inventory'),checks:[],cleanup_errors:[]};
  const selected=plan??native('queue-plan',{packet}),clients=[];let releaseClaim=()=>{},primaryError=null;
  evidence.queue.steps=[];
  const headers=client=>({Origin:origin,Authorization:`Bearer ${client.tokens.access_token}`,'X-CSRF-Token':client.tokens.csrf_token});
  const owned=()=>readFile(manifest,'utf8').then(JSON.parse);
  const finishTrace=async client=>{
    if(!client.tracing)return;
    try{await client.context.tracing.stop({path:client.trace});evidence.queue.private_traces??=[];evidence.queue.private_traces.push(client.trace);}
    catch(error){evidence.queue.cleanup_errors.push(error.message.slice(0,300));}
    finally{client.tracing=false;}
  };
  const closeClient=async client=>{
    if(client.closed)return;
    await finishTrace(client);
    try{assert.equal((await client.context.request.post(`${origin}/api/v1/auth/logout`,{headers:headers(client)})).status(),204);}
    finally{await client.context.close();client.closed=true;}
  };
  const makeClient=async(role,visible=true)=>{
    const account=credentials.accounts.find(account=>account.role===role);assert(account);
    const context=await browser.newContext({viewport:{width:1440,height:900}}),client={role,context};clients.push(client);
    if(visible){client.page=await context.newPage();watch(client.page,`queue-${role}-${clients.length}`);await client.page.goto(origin);client.tokens=await authenticate(client.page,account);}
    else{const response=await context.request.post(`${origin}/api/v1/auth/login`,{headers:{Origin:origin},data:{login:account.login,password:account.password}});
      assert.equal(response.status(),200);client.tokens=await response.json();}
    if(visible){client.trace=resolve(root,`.local/p12-browser-stage3-queue-${packet}-${clients.length}.zip`);
      await context.tracing.start({screenshots:true,snapshots:true,sources:false});client.tracing=true;}
    return client;
  };
  const json=async(client,method,path,body,status=200)=>{
    const response=await client.context.request.fetch(`${origin}/api/v1${path}`,{method,headers:{...headers(client),'Idempotency-Key':randomUUID()},...(body?{data:body}:{})});
    assert.equal(response.status(),status);return status===204?null:response.json();
  };
  const prepare=async(client,kind)=>{
    const title=`P12 queue ${kind} ${packet}`,chat=await json(client,'POST','/agent/sessions',{title},201);
    let fixture=await owned();fixture.chats.push(chat.id);fixture.chat_owners??={};fixture.chat_owners[chat.id]=client.role;
    await writeFile(manifest,JSON.stringify(fixture,null,2));
    const response=await fetch(`${origin}/api/v1/agent/chat/stream`,{method:'POST',headers:{...headers(client),'Content-Type':'application/json','Idempotency-Key':randomUUID()},
      body:JSON.stringify({session_id:chat.id,message:`Controlled P12 ${kind} fixture. No model call. ${selected.reason}`,attachments:[]}),signal:AbortSignal.timeout(10000)});
    assert.equal(response.status,200);const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',event;
    try{while(!event){const next=await reader.read();assert(!next.done);buffer+=decoder.decode(next.value,{stream:true});let boundary;
      while((boundary=/\r?\n\r?\n/.exec(buffer))){const block=buffer.slice(0,boundary.index);buffer=buffer.slice(boundary.index+boundary[0].length);
        if(block.split(/\r?\n/).includes('event: session'))event=JSON.parse(block.split(/\r?\n/).find(line=>line.startsWith('data:')).slice(5));}
    }}finally{await reader.cancel();reader.releaseLock();}
    assert.equal(event.session_id,chat.id);fixture=await owned();fixture.runs.push(event.run_id);
    fixture.run_owners??={};fixture.run_owners[event.run_id]=client.role;fixture.chat_owners??={};fixture.chat_owners[chat.id]=client.role;
    await writeFile(manifest,JSON.stringify(fixture,null,2));
    const proposal=native('queue-prepare',{case:kind,run_id:event.run_id});
    const actual=await json(client,'GET',`/agent/proposals/${proposal.id}`);assert.equal(actual.context_files.length,0);
    assert.equal(actual.status,'pending');assert.equal(actual.preview.affected_rows,1);
    evidence.queue.steps.push({step:'guarded_fixture_prepared',case:kind,proposal_id:proposal.id,version:proposal.version,provider_calls:0});
    return {...proposal,chat_id:chat.id,run_id:event.run_id};
  };
  const queue=async(client,box='incoming')=>{
    const page=client.page,summary=page.locator('.proposal-queue summary');
    if(await page.locator('.chat .toggle').getAttribute('aria-expanded')!=='true')await page.locator('.chat .toggle').click();
    if(!await page.locator('.proposal-queue').evaluate(element=>element.open))await summary.click();
    const section=page.locator('.proposal-queue'),button=section.getByRole('button',{name:new RegExp(`^${box==='incoming'?'Входящие':box==='mine'?'Мои':'История'} \\(`)});
    await button.click();const response=page.waitForResponse(r=>responseFor('/agent/proposals')(r)&&new URL(r.url()).searchParams.get('box')===box);
    await section.getByRole('button',{name:'Обновить',exact:true}).click();await response;return section;
  };
  const open=async(client,proposal,box='incoming')=>{
    const section=await queue(client,box),card=section.locator('.proposal-card').filter({has:client.page.getByText(proposal.explanation,{exact:true})});
    await card.getByRole('button',{name:'Открыть',exact:true}).click();
    const dialog=client.page.getByRole('dialog',{name:'Изменение от агента',exact:true});await dialog.locator('.diff').waitFor();return dialog;
  };
  const close=dialog=>dialog.locator('.form-head button[aria-label="Закрыть"]').click();
  const field=(dialog,label)=>dialog.locator('label.field').filter({hasText:label});
  const assignment=async(client,dialog)=>{
    const response=client.page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname.endsWith('/assignment'));
    await dialog.getByRole('button',{name:'Взять в работу',exact:true}).click();assert.equal((await response).status(),200);
  };
  try{
    const author=await makeClient('student',false),document=selected.document??await prepare(author,'document');
    if(resumed)evidence.queue.steps.push({step:'resumed_guarded_document',proposal_id:document.id,version:document.version,new_prepare_calls:0});
    // Retain this API-only owner until finally can delete its own conversation.
    const staff=await makeClient('dean_staff'),old=selected.transferred?null:await makeClient('dean_staff'),director=await makeClient('director');
    if(!selected.submitted_correction){
    if(!selected.transferred){
    const primary=await open(staff,document),stale=await open(old,document);
    // Hold a genuine committed assignment response to verify native busy/close guards.
    let observed,failed;const reached=new Promise((resolve,reject)=>{observed=resolve;failed=reject;}),held=new Promise(resolve=>{releaseClaim=resolve;});
    const deadline=setTimeout(()=>failed(new Error('Actual assignment response did not reach the timing gate')),15000);
    await staff.page.route(`**/api/v1/agent/proposals/${document.id}/assignment`,async route=>{
      try{const actual=await route.fetch();assert.equal(actual.status(),200);observed();await held;await route.fulfill({response:actual});}
      catch(error){failed(error);await route.abort().catch(()=>{});}
    });
    await Promise.all([primary.getByRole('button',{name:'Взять в работу',exact:true}).click(),reached]).finally(()=>clearTimeout(deadline));
    await staff.page.keyboard.press('Escape');assert(await primary.isVisible());assert(await primary.locator('.form-head button[aria-label="Закрыть"]').isDisabled());
    assert(await primary.getByRole('button',{name:'Взять в работу',exact:true}).isDisabled());
    const claimed=staff.page.waitForResponse(r=>responseFor(`/agent/proposals/${document.id}/assignment`)(r));releaseClaim();await claimed;
    await primary.getByRole('button',{name:'Передать',exact:true}).waitFor();
    evidence.queue.steps.push({step:'claim_busy',status:200,escape_did_not_close:true,close_disabled:true});
    await staff.page.unroute(`**/api/v1/agent/proposals/${document.id}/assignment`);
    const staleClaim=old.page.waitForResponse(r=>new URL(r.url()).pathname===`/api/v1/agent/proposals/${document.id}/assignment`);
    await stale.getByRole('button',{name:'Взять в работу',exact:true}).click();assert.equal((await staleClaim).status(),409);
    await stale.getByRole('button',{name:'Подтвердить',exact:true}).waitFor();
    evidence.queue.steps.push({step:'stale_claim',status:409});
    await primary.getByRole('button',{name:'Передать',exact:true}).click();
    await field(primary,'Кому передать').locator('select').selectOption(String(selected.director));
    await field(primary,'Причина передачи').locator('textarea').fill(selected.reason);
    const transferred=staff.page.waitForResponse(responseFor(`/agent/proposals/${document.id}/assignment`));
    await primary.getByRole('button',{name:'Передать предложение',exact:true}).click();await transferred;
    evidence.queue.steps.push({step:'transferred_to_director',status:200});
    await field(stale,'Комментарий к решению (не короче 10 символов)').locator('textarea').fill(selected.reason);
    const obsolete=old.page.waitForResponse(r=>new URL(r.url()).pathname===`/api/v1/agent/proposals/${document.id}/decision`);
    await stale.getByRole('button',{name:'Подтвердить',exact:true}).click();assert.equal((await obsolete).status(),404);
    await stale.getByRole('button',{name:'Подтвердить',exact:true}).waitFor({state:'detached'});
    evidence.queue.steps.push({step:'stale_old_assignee_decision',status:404,decision_buttons_removed:true});
    await close(stale);await close(primary);await closeClient(old);
    }else{
      await json(staff,'GET',`/agent/proposals/${document.id}`,undefined,404);
      evidence.queue.steps.push({step:'resumed_transferred_document',version:3,former_assignee_status:404,repeated_assignments:0});
    }
    const decision=await open(director,document);assert.equal(await decision.locator('.attach-hint summary').count(),0);
    await field(decision,'Комментарий к решению (не короче 10 символов)').locator('textarea').fill(selected.reason);
    const attempts=[];
    await director.page.route(`**/api/v1/agent/proposals/${document.id}/decision`,async route=>{
      const request=route.request(),headers=await request.allHeaders();attempts.push({body:request.postData(),key:headers['idempotency-key']});
      if(attempts.length===1)await route.abort('connectionreset');else await route.continue();
    });
    await decision.getByRole('button',{name:'Подтвердить',exact:true}).click();
    await decision.getByRole('button',{name:'Повторить запрос',exact:true}).waitFor();
    assert(await field(decision,'Комментарий к решению (не короче 10 символов)').locator('textarea').isDisabled());
    evidence.queue.checks.push(native('queue-check',{case:'document',expect:'document-pending'}));
    await close(decision);const retryDialog=await open(director,document);
    assert(await retryDialog.getByRole('button',{name:'Повторить запрос',exact:true}).isVisible());
    const approved=director.page.waitForResponse(responseFor(`/agent/proposals/${document.id}/decision`));
    await retryDialog.getByRole('button',{name:'Повторить запрос',exact:true}).click();await approved;
    assert.equal(attempts.length,2);assert.deepEqual(attempts[0],attempts[1]);evidence.queue.immutable_decision_retry={attempts:2,same_body:true,same_key:true,close_reopen:true};
    await director.page.unroute(`**/api/v1/agent/proposals/${document.id}/decision`);await retryDialog.getByText('Исполнено',{exact:true}).waitFor();
    const history=retryDialog.locator('details').filter({hasText:'История действий'});await history.locator('summary').click();
    await history.getByText(/Взято в работу/).first().waitFor();await history.getByText(/Назначен согласующий/).first().waitFor();await history.getByText(/Подтверждено/).first().waitFor();
    evidence.queue.checks.push(native('queue-check',{case:'document'}));await close(retryDialog);
    }
    let correction=selected.submitted_correction;
    if(!correction){
    const teacher=await makeClient('teacher');correction=await prepare(teacher,'correction');
    const draft=await open(teacher,correction,'mine');await draft.getByRole('heading',{name:'Коррекция оценки',exact:true}).waitFor();
    assert.equal(await draft.getByRole('button',{name:'Подтвердить',exact:true}).count(),0);assert.equal(await draft.getByRole('button',{name:'Отклонить',exact:true}).count(),0);
    evidence.queue.checks.push(native('queue-check',{case:'correction',expect:'correction-draft'}));
    await json(director,'GET',`/agent/proposals/${correction.id}`,undefined,404);
    const submitted=teacher.page.waitForResponse(responseFor(`/agent/proposals/${correction.id}/submit`));
    await draft.getByRole('button',{name:'Подать заявку',exact:true}).click();const submittedProposal=await (await submitted).json();
    assert.equal(submittedProposal.submission_status,'submitted');assert(submittedProposal.correction_id);
    evidence.queue.checks.push(native('queue-check',{case:'correction',expect:'correction-submitted'}));
    await close(draft);
    }
    await json(staff,'GET',`/agent/proposals/${correction.id}`);
    const staffQueue=await queue(staff);assert.equal(await staffQueue.locator('.proposal-card').filter({hasText:correction.explanation}).count(),1);
    evidence.queue.steps.push({step:'correction_actual_deputy_visible',status:200,queue_card_visible:true,ordinary_staff_negative:'covered by real DB contract tests'});
    const review=await open(director,correction);await assignment(director,review);
    await field(review,'Комментарий к решению (не короче 10 символов)').locator('textarea').fill(selected.reason);
    const rejected=director.page.waitForResponse(responseFor(`/agent/proposals/${correction.id}/decision`));
    await review.getByRole('button',{name:'Отклонить',exact:true}).click();await rejected;
    await review.getByText('Отклонено',{exact:true}).first().waitFor();evidence.queue.checks.push(native('queue-check',{case:'correction'}));await close(review);
    evidence.queue.materials={linked_files:0,claim:'no files attached; attachment acknowledgement not simulated'};
    evidence.queue.stale_actions={claim:409,old_assignee_decision:404};
  }catch(error){primaryError=error;evidence.queue.primary_failure=error.message.slice(0,1200);throw error;}
  finally{
    releaseClaim();const fixture=await owned();
    for(const client of clients)await finishTrace(client);
    // Immutable proposals/corrections/official audit remain. Conversation copies alone are deleted.
    for(const chat of fixture.chats){
      const owner=fixture.chat_owners?.[chat],client=clients.find(client=>client.role===owner&&!client.closed);
      if(!client){(evidence.queue.cleanup_owner_absent??=[]).push(chat);continue;}
      try{
        const current=await client.context.request.get(`${origin}/api/v1/agent/sessions/${chat}`,{headers:headers(client)});assert([200,404].includes(current.status()));
        if(current.status()===200){const active=(await current.json()).activeRunId;
          if(active)assert([200,202].includes((await client.context.request.post(`${origin}/api/v1/agent/runs/${active}/cancel`,{headers:headers(client),data:{}})).status()));}
        const response=await client.context.request.delete(`${origin}/api/v1/agent/sessions/${chat}`,{headers:headers(client)});assert([204,404].includes(response.status()));
      }
      catch(error){evidence.queue.cleanup_errors.push(error.message.slice(0,300));}
    }
    for(const client of clients){try{if(client.tokens)await closeClient(client);else await client.context.close();}catch(error){evidence.queue.cleanup_errors.push(error.message.slice(0,300));}}
    try{evidence.queue.cleanup=native('cleanup');}catch(error){evidence.queue.cleanup_errors.push(error.message.slice(0,400));}
    if(!primaryError)assert.equal(evidence.queue.cleanup_errors.length,0,JSON.stringify(evidence.queue.cleanup_errors));
  }
}
