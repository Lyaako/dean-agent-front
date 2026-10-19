// Actual Vite/React browser gates. Private passwords and response tokens stay in memory.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const require = createRequire(import.meta.url);
// shortcut: bundled browser paths are local to this host; use a portable runner when moving these checks to CI.
const { chromium } = require('C:/Users/PurpleCloud/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root = resolve(import.meta.dirname, '../../..');
const origin = 'http://127.0.0.1:5174';
const phase = process.argv[2] ?? 'baseline';
const selectedRoles=process.argv[3]?.split(',');
if (selectedRoles) { assert.equal(phase,'stage1'); assert(selectedRoles.length && new Set(selectedRoles).size === selectedRoles.length && selectedRoles.every(role=>['admin','director','dean_staff','teacher','student'].includes(role))); }
assert(['render', 'discipline', 'baseline', 'stage1', 'auth', 'sql', 'stage2-olap', 'stage2-controls', 'stage2-forms', 'stage2-workflow-retry', 'stage2-workflow-lifecycle', 'stage2-edges', 'stage3-chat', 'stage3-chat-continuation', 'stage3-chat-tail', 'stage3-queue', 'stage3-files'].includes(phase));
// Heavy browser/runtime activity is a separate resource gate from source preparation.
if (phase.startsWith('stage3-')) assert.equal(process.env.P12_STAGE3_RESOURCE_GO,'1','Stage3 runtime waits for root resource GO');
const output = resolve(root, `.nelson/missions/2026-10-11_065347_b2445e93/task${phase.startsWith('stage2-') || phase.startsWith('stage3-') ? 16 : ['stage1','auth','sql'].includes(phase) ? 12 : 8}-browser-${phase}${selectedRoles ? '-'+selectedRoles.join('-') : ''}.json`);
const evidence = { phase, origin, strictMode: true, roles: [], errors: [], requests: [] };
const controls = [], diagnostics = [];
const cookieGenerations = new Map();
const started = Date.now();
const browser = await chromium.launch({ headless: true, executablePath: 'C:/Users/PurpleCloud/AppData/Local/ms-playwright/chromium-1208/chrome-win64/chrome.exe' });
evidence.browser = browser.version();
const tabs = [['students','Студенты','v_student_summary'],['groups','Группы','v_groups'],['schedule','Расписание','v_schedule_calendar'],['works','Курсовые и ВКР','v_academic_works'],['requests','Заявки на справки','v_document_queue'],['practice','Практики','v_practice'],['employees','Сотрудники','v_employees'],['olap','OLAP-анализ',null]];
const modes = [['rollup-group','Roll-up по группе'],['rollup-discipline','Roll-up по дисциплине'],['rollup-semester','Roll-up по семестру'],['slice-group','Срез по группе'],['slice-discipline','Срез по дисциплине'],['dice','Dice'],['drilldown-group','Drill-down по группе'],['cross-group-semester','Кросс-таблица Группа × Семестр']];
const responseFor = (path, status = 200) => r => new URL(r.url()).pathname === `/api/v1${path}` && r.status() === status;
function watch(page, role) {
  page.on('pageerror', error => evidence.errors.push({ role, message: error.message.slice(0,300) }));
  page.on('response', response => { const url = new URL(response.url()); if (url.pathname.startsWith('/api/v1')) {
    const request = {role, method:response.request().method(), path:url.pathname, status:response.status(), ms:Date.now()-started, requestMs:Math.round(response.request().timing().startTime-started)};
    evidence.requests.push(request);
    if (url.pathname === '/api/v1/auth/refresh') diagnostics.push(response.request().allHeaders().then(headers=>{
      const cookie=headers.cookie ?? '';
      if (!cookieGenerations.has(cookie)) cookieGenerations.set(cookie,cookieGenerations.size+1);
      request.cookieGeneration=cookieGenerations.get(cookie); request.hasCsrf=!!headers['x-csrf-token'];
    }));
    if (!response.ok() && response.status() !== 204) diagnostics.push(response.json().then(body => {request.code=body?.error?.code ?? 'unknown';}).catch(() => {request.code='non_json';}));
  } });
}
async function loggedIn(page) { await page.locator('.avatar-btn').waitFor(); }
async function loggedOut(page) { await page.getByRole('button', {name:'Войти',exact:true}).waitFor(); }
async function authenticate(page,account) {
  await loggedOut(page);
  await page.getByLabel('Логин',{exact:true}).fill(account.login);
  await page.getByLabel('Пароль',{exact:true}).fill(account.password);
  const me = page.waitForResponse(responseFor('/auth/me'));
  const issued = page.waitForResponse(responseFor('/auth/login'));
  await page.getByRole('button',{name:'Войти',exact:true}).click();
  assert.deepEqual((await (await me).json()).roles,[account.role]); await loggedIn(page);
  return (await issued).json();
}
async function signout(page) {
  await page.locator('.avatar-btn').click(); await page.getByRole('menuitem',{name:'Выйти'}).click(); await loggedOut(page);
}
async function settleTable(page) { await page.waitForFunction(() => !document.querySelector('.table-card .skel')); }
const keyOf = (mode,row) => mode === 'dice' ? `${row.student_id}|${row.discipline_id}|${row.semester}` : String(row[mode === 'drilldown-group' ? 'student_id' : mode === 'rollup-semester' ? 'semester' : mode === 'rollup-discipline' || mode === 'slice-group' ? 'discipline_id' : 'group_id']);
async function checkTable(page,report) {
  await settleTable(page);
  const expected = new Map(report.rows.map(row => [keyOf(report.mode,row),row]));
  const seen = new Set();
  while (true) {
    for (const displayed of await page.locator('.table-card tbody tr[data-k]').evaluateAll(rows => rows.map(row => ({key:row.dataset.k,cells:[...row.cells].map(cell=>cell.textContent.trim())})))) {
      assert(expected.has(displayed.key), `${report.mode}: unexpected table row ID`);
      const row = expected.get(displayed.key); seen.add(displayed.key);
      if (report.mode === 'cross-group-semester') assert.deepEqual(displayed.cells.slice(1),report.semesters.map(sem=>String(row.semesters[String(sem)] ?? '—')));
      else if (report.mode === 'drilldown-group') assert.deepEqual(displayed.cells.slice(1,3),[String(row.avg ?? '—'),String(row.debts)]);
      else if (report.mode !== 'dice') assert.deepEqual(displayed.cells.slice(1),['avg','results','excellent','debts'].map(key=>String(row[key] ?? '—')));
    }
    const next = page.getByRole('button',{name:'Следующая страница',exact:true});
    if (!await next.count() || await next.isDisabled()) break;
    await next.click();
  }
  assert.equal(seen.size,report.rows.length,`${report.mode}: rendered pagination coverage`);
  if (report.mode.startsWith('rollup-') && report.rows.length) {
    const sorted = [...report.rows].sort((a,b)=>report.mode === 'rollup-semester' ? a.semester-b.semester : Number(b.avg)-Number(a.avg));
    if (report.mode === 'rollup-semester') assert.deepEqual(await page.locator('.line-chart .pt-v').allTextContents(),sorted.filter(row=>row.avg != null).map(row=>String(row.avg)));
    else assert.deepEqual(await page.locator('.dp-v').allTextContents(),sorted.map(row=>String(row.avg ?? '—')));
  }
}
try {
  if (phase === 'stage3-files') {
    const { stage3Files } = await import('./stage3-files.mjs');
    await stage3Files({browser,root,origin,evidence,watch,authenticate});
  } else if (phase === 'stage3-chat') {
    const { stage3Chat } = await import('./stage3-chat.mjs');
    await stage3Chat({browser,root,origin,evidence,watch,authenticate,loggedIn,responseFor});
  } else if (phase === 'stage3-chat-continuation') {
    const { stage3ChatContinue } = await import('./stage3-chat.mjs');
    await stage3ChatContinue({browser,root,origin,evidence,watch,authenticate,loggedIn,responseFor});
  } else if (phase === 'stage3-chat-tail') {
    const { stage3ChatTail } = await import('./stage3-chat.mjs');
    await stage3ChatTail({browser,root,origin,evidence,watch,authenticate,loggedIn,responseFor});
  } else if (phase === 'stage3-queue') {
    const { stage3Queue } = await import('./stage3-queue.mjs');
    await stage3Queue({browser,root,origin,evidence,watch,authenticate,responseFor});
  } else if (phase === 'render') {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    watch(page, 'anonymous');
    await page.goto(origin); await loggedOut(page);
    assert(await page.getByLabel('Логин', {exact:true}).isVisible());
    assert(await page.getByLabel('Пароль', {exact:true}).isVisible());
    assert(await page.getByRole('button', {name:'Войти',exact:true}).isDisabled());
    evidence.render = 'passed';
  } else if (phase === 'sql') {
    const fixture = JSON.parse(await readFile(resolve(root,'.local/p12-browser-credentials.json'),'utf8'));
    evidence.database=fixture.database;
    for (const account of fixture.accounts.filter(a=>['admin','director'].includes(a.role))) {
      const context=await browser.newContext();
      const issued=await context.request.post(`${origin}/api/v1/auth/login`,{data:{login:account.login,password:account.password},headers:{Origin:origin}});
      assert.equal(issued.status(),200);
      const tokens=await issued.json(), headers={Origin:origin,Authorization:`Bearer ${tokens.access_token}`,'X-CSRF-Token':tokens.csrf_token};
      try {
        const groups=await context.request.get(`${origin}/api/v1/resources/study_group?limit=500`,{headers}), disciplines=await context.request.get(`${origin}/api/v1/resources/discipline?limit=500`,{headers});
        assert.equal(groups.status(),200); assert.equal(disciplines.status(),200);
        const group=(await groups.json()).items[0].group_id, discipline=(await disciplines.json()).items[0].discipline_id;
        for (const [mode] of modes) {
          const url=new URL(`${origin}/api/v1/olap`); url.searchParams.set('mode',mode);
          if (['slice-group','drilldown-group'].includes(mode)) url.searchParams.set('group_id',group);
          if (mode === 'slice-discipline') url.searchParams.set('discipline_id',discipline);
          const response=await context.request.get(url.toString(),{headers}); assert.equal(response.status(),200);
          controls.push({role:account.role,report:await response.json()});
          evidence.requests.push({role:account.role,method:'GET',path:'/api/v1/olap',mode,status:response.status()});
        }
      } finally {assert.equal((await context.request.post(`${origin}/api/v1/auth/logout`,{headers})).status(),204); await context.close();}
    }
  } else if (phase === 'auth') {
    const fixture = JSON.parse(await readFile(resolve(root,'.local/p12-browser-credentials.json'),'utf8'));
    evidence.database=fixture.database; evidence.auth={switch:{},rounds:[]};
    const context=await browser.newContext({viewport:{width:1440,height:900}});
    const page=await context.newPage(); watch(page,'auth-focus'); await page.goto(origin);
    evidence.auth.webLocks=await page.evaluate(()=>({available:!!navigator.locks,secure:window.isSecureContext}));
    await authenticate(page,fixture.accounts.find(a=>a.role==='admin'));
    await page.locator('[role=tab][href="/students"]').click();
    await page.getByRole('textbox',{name:/^Поиск:/}).fill('__p12_account_scope_probe__');
    await page.locator('[role=tab][href="/schedule"]').click(); await page.getByRole('button',{name:'Неделя',exact:true}).click();
    await signout(page); await authenticate(page,fixture.accounts.find(a=>a.role==='student'));
    evidence.auth.switch.scheduleReset=await page.getByRole('button',{name:'Таблица',exact:true}).getAttribute('aria-pressed') === 'true';
    await page.locator('[role=tab][href="/students"]').click();
    evidence.auth.switch.tableReset=await page.getByRole('textbox',{name:/^Поиск:/}).inputValue() === '';
    await signout(page); await authenticate(page,fixture.accounts.find(a=>a.role==='admin'));
    const second=await context.newPage(); watch(second,'auth-second'); await second.goto(origin); await loggedIn(second);
    let observed,profileFailed,release;
    const profileObserved=new Promise((resolve,reject)=>{observed=resolve;profileFailed=reject;}), profileRelease=new Promise(resolve=>{release=resolve;});
    const profileTimeout=setTimeout(()=>profileFailed(new Error('Actual profile response did not reach timing gate')),30000);
    await page.route('**/api/v1/resources/person?*',async route=>{
      try {const response=await route.fetch(); assert.equal(response.status(),200); observed(); await profileRelease; await route.fulfill({response});}
      catch(error) {profileFailed(error);}
    });
    const lateReload=page.reload(); await profileObserved.finally(()=>clearTimeout(profileTimeout));
    await signout(second); await authenticate(second,fixture.accounts.find(a=>a.role==='student'));
    release(); await lateReload; await loggedOut(page); await page.unroute('**/api/v1/resources/person?*');
    evidence.auth.lateProfile={timingInterception:'held an actual person200 response while other tab logged out and entered student',staleAccountRejected:true};
    const studentMe=page.waitForResponse(responseFor('/auth/me')); await page.reload(); await loggedIn(page);
    assert.deepEqual((await (await studentMe).json()).roles,['student']);
    await signout(page); await loggedOut(second); await authenticate(page,fixture.accounts.find(a=>a.role==='director'));
    await second.reload(); await loggedIn(second);
    for (let round=1;round<=8;round++) {
      await Promise.all([page.reload(),second.reload()]);
      try { await Promise.all([loggedIn(page),loggedIn(second)]); evidence.auth.rounds.push({round,authenticated:true}); }
      catch(error) {evidence.auth.rounds.push({round,authenticated:false}); throw error;}
    }
    await signout(page); await loggedOut(second);
    assert(evidence.auth.switch.scheduleReset,'Account switch retained previous schedule controls');
    assert(evidence.auth.switch.tableReset,'Account switch retained previous table filters');
  } else if (phase === 'stage2-edges') {
    const fixture=JSON.parse(await readFile(resolve(root,'.local/p12-browser-credentials.json'),'utf8'));
    const edge=JSON.parse(await readFile(resolve(root,'.local/p12-browser-stage2-edge-fixture.json'),'utf8'));
    assert.equal(edge.database,fixture.database);evidence.database=fixture.database;evidence.edges={role:'admin',student_ids:edge.student_ids};
    const context=await browser.newContext({viewport:{width:1440,height:900}}),page=await context.newPage();
    watch(page,'admin');await page.goto(origin);const login=await authenticate(page,fixture.accounts.find(a=>a.role==='admin'));
    try{
      await page.locator('[role=tab][href="/olap"]').click();await page.getByRole('heading',{name:'OLAP-анализ',exact:true}).waitFor();
      const select=label=>page.locator('.ops .filters label').filter({has:page.getByText(label,{exact:true})}).locator('select');
      const after=async(action,mode,field,value)=>{
        const pending=page.waitForResponse(r=>responseFor('/olap')(r)&&new URL(r.url()).searchParams.get('mode')===mode&&(!field||new URL(r.url()).searchParams.get(field)===String(value)));
        await action();const report=await (await pending).json();await settleTable(page);return report;
      };
      let report=await after(()=>page.getByRole('button',{name:'Dice',exact:true}).click(),'dice');
      report=await after(()=>select('Группа').selectOption(String(edge.group_id)),'dice','group_id',edge.group_id);
      report=await after(()=>select('Семестр').selectOption(String(edge.semester)),'dice','semester',edge.semester);
      const expected=new Map(edge.rows.map(row=>[keyOf('dice',row),row])),selected=report.rows.filter(row=>edge.student_ids.includes(row.student_id));
      assert.equal(selected.length,4);assert.equal(new Set(selected.map(row=>keyOf('dice',row))).size,4);
      for(const row of selected){const exact=expected.get(keyOf('dice',row));assert(exact);for(const [key,value]of Object.entries(exact))assert.deepEqual(row[key],value);assert.equal(row.has_debt,row.points===null);}
      await page.getByRole('textbox',{name:'Поиск: Студент',exact:true}).fill(edge.name);
      await page.waitForFunction(()=>document.querySelectorAll('.table-card tr[data-k]').length===4);
      await checkTable(page,{...report,rows:selected});
      const displayed=await page.locator('.table-card tr[data-k]').evaluateAll(rows=>rows.map(row=>({id:row.dataset.k,points:row.cells[5].textContent.trim(),result:row.cells[6].textContent.trim(),debt:row.cells[7].textContent.trim()})));
      for(const row of displayed){const exact=selected.find(item=>keyOf('dice',item)===row.id);assert.equal(row.points,String(exact.points??'—'));assert.equal(row.result,exact.result);assert.equal(row.debt,exact.has_debt?'долг':'—');}
      controls.push({role:'admin',report});
      const resultPoints=selected.filter(row=>row.points!=null).map(row=>row.points);
      assert.equal(resultPoints.length,3);assert.equal(selected.filter(row=>row.is_graded&&row.mark===5).length,1);
      assert.equal(selected.filter(row=>row.has_debt).length,1);assert(selected.some(row=>!row.is_graded&&row.mark===5&&!row.has_debt));
      report=await after(()=>page.getByRole('button',{name:'Drill-down по группе',exact:true}).click(),'drilldown-group');
      assert.equal(report.filters.group_id,edge.group_id);const students=report.rows.filter(row=>edge.student_ids.includes(row.student_id));assert.equal(students.length,2);
      assert.equal(students[0].student,students[1].student);assert.notEqual(students[0].student_id,students[1].student_id);
      const first=students.find(row=>row.student_id===edge.student_ids[0]),second=students.find(row=>row.student_id===edge.student_ids[1]);
      assert.equal(first.avg,Number(edge.high).toFixed(2));assert.equal(first.debts,1);assert.equal(second.avg,Number(edge.low).toFixed(2));assert.equal(second.debts,0);
      await page.getByRole('textbox',{name:'Поиск: Студент',exact:true}).fill(edge.name);
      await page.waitForFunction(()=>document.querySelectorAll('.table-card tr[data-k]').length===2);
      await checkTable(page,{...report,rows:students});controls.push({role:'admin',report});
      evidence.edges={...evidence.edges,raw_attempts:6,final_results:4,distinct_dice_keys:true,same_name_distinct_ids:true,latest_retake_only:true,
        nullCountedButNotAveraged:true,nongradedNotExcellent:true,oneDebt:true,individualMeans:[first.avg,second.avg],uiDice:true,uiDrilldown:true};
    }finally{
      const cleanup=await context.request.post(`${origin}/api/v1/auth/logout`,{headers:{Origin:origin,Authorization:`Bearer ${login.access_token}`,'X-CSRF-Token':login.csrf_token}});
      evidence.authCleanupStatus=cleanup.status();assert([204,401].includes(cleanup.status()));await context.close();
    }
  } else if (phase === 'stage2-workflow-lifecycle') {
    const fixture=JSON.parse(await readFile(resolve(root,'.local/p12-browser-credentials.json'),'utf8'));
    const enrolled=JSON.parse(await readFile(resolve(root,'.local/p12-browser-stage2-workflows.json'),'utf8'));
    const returnFixture=JSON.parse(await readFile(resolve(root,'.local/p12-browser-stage2-return-fixture.json'),'utf8'));
    assert.equal(enrolled.database,fixture.database);assert.equal(enrolled.status,200);evidence.database=fixture.database;
    assert.equal(returnFixture.database,fixture.database);
    const privatePath=resolve(root,'.local/p12-browser-stage2-lifecycle.json');
    let progress;
    try{progress=JSON.parse(await readFile(privatePath,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;progress={student_id:enrolled.result.student_id,suffix:Date.now().toString(36),cases:[]};}
    assert.equal(progress.student_id,enrolled.result.student_id);evidence.workflow={role:'admin',priorCases:progress.cases.length,cases:[]};
    const context=await browser.newContext({viewport:{width:1440,height:900}}),page=await context.newPage();
    watch(page,'admin');await page.goto(origin);const login=await authenticate(page,fixture.accounts.find(a=>a.role==='admin'));
    try{
      const choices=enrolled.choices,date=new Date(`${choices.today}T00:00:00Z`);date.setUTCDate(date.getUTCDate()+30);
      const steps=[
        {name:'transfer_student',title:'Перевод в другую группу',confirm:'Перевести',fields:{group_name:choices.groups[1].name},group:choices.groups[1].name,status:'Обучается',next:'Академический отпуск'},
        {name:'grant_academic_leave',title:'Академический отпуск',confirm:'Оформить',fields:{reason:choices.leave_reason,start:choices.today,end:date.toISOString().slice(0,10)},group:choices.groups[1].name,status:'Академический отпуск',next:'Выход из академического отпуска'},
        {name:'return_from_leave',title:'Выход из академического отпуска',confirm:'Оформить',fields:{},student_id:returnFixture.student_id,group:returnFixture.group_name,status:'Обучается',next:'Академический отпуск'},
        {name:'expel_student',title:'Отчисление',confirm:'Отчислить',fields:{reason:'Проверка интерфейса на отдельной тестовой базе'},group:choices.groups[1].name,status:'Отчислен',next:'Восстановление'},
        {name:'reinstate_student',title:'Восстановление',confirm:'Восстановить',fields:{group_name:choices.groups[0].name},group:choices.groups[0].name,status:'Обучается',next:'Академический отпуск'},
      ];
      assert(progress.cases.length<=steps.length);
      const headers={Origin:origin,Authorization:`Bearer ${login.access_token}`,'X-CSRF-Token':login.csrf_token};
      const summary=async(studentId=progress.student_id)=>{
        const response=await context.request.get(`${origin}/api/v1/resources/v_student_summary?student_id=${studentId}`,{headers});
        assert.equal(response.status(),200);const rows=(await response.json()).items;assert.equal(rows.length,1);return rows[0];
      };
      if(progress.cases.length){const prior=steps[progress.cases.length-1],current=await summary(prior.student_id??progress.student_id);assert.equal(current.group_name,prior.group);assert.equal(current.status,prior.status);}
      await page.locator('[role=tab][href="/students"]').click();await settleTable(page);
      await page.getByRole('textbox',{name:/^Поиск:/}).fill(enrolled.last_name);
      for(let i=progress.cases.length;i<steps.length;i++){
        const step=steps[i],studentId=step.student_id??progress.student_id,subject=await summary(studentId);
        await page.getByRole('textbox',{name:/^Поиск:/}).fill(String(subject.student));
        const row=page.locator(`.table-card tr[data-k="${studentId}"]`);await row.waitFor();await row.click();
        const studentDialog=page.getByRole('dialog').filter({has:page.getByRole('button',{name:'Приказ',exact:true})});
        await studentDialog.getByRole('button',{name:'Приказ',exact:true}).click();
        await studentDialog.getByRole('menuitem',{name:step.title,exact:true}).click();
        const dialog=page.getByRole('dialog',{name:step.title,exact:true});await dialog.waitFor();
        const choose=async(name,label)=>{
          await dialog.locator(`#wf-${name}`).locator('..').click();await dialog.locator(`#wf-${name}`).fill(label);
          await dialog.getByRole('option').filter({has:page.getByText(label,{exact:true})}).click();
        };
        for(const [name,value]of Object.entries(step.fields)){
          if(name==='group_name'||name==='reason'&&step.name==='grant_academic_leave')await choose(name,value);
          else await dialog.locator(`#wf-${name}`).fill(value);
        }
        await dialog.locator('#wf-order_number').fill(`P12L-${progress.suffix}-${i+1}`);await choose('signed_by',choices.signer.label);
        const pending=page.waitForResponse(r=>new URL(r.url()).pathname===`/api/v1/workflows/${step.name}`&&r.request().method()==='POST');
        await dialog.getByRole('button',{name:step.confirm,exact:true}).click();const response=await pending,result=await response.json();
        const native={name:step.name,status:response.status(),result};evidence.workflow.cases.push(native);
        if(response.status()===200){progress.cases.push(native);await writeFile(privatePath,JSON.stringify(progress,null,2));}
        assert.equal(response.status(),200);assert.equal(result.status,'applied');assert.equal(result.student_id,studentId);
        await dialog.waitFor({state:'detached'});
        const current=await summary(studentId);assert.equal(current.group_name,step.group);assert.equal(current.status,step.status);
        const statusIndex=await page.locator('.table-card th').evaluateAll(headers=>headers.findIndex(h=>h.textContent.replace(/[↑↓]/g,'').trim()==='Статус'));
        assert(statusIndex>=0);const statusCell=row.locator('td').nth(statusIndex);
        await statusCell.filter({hasText:step.status}).waitFor();assert.equal((await statusCell.innerText()).trim(),step.status);
        native.actualGroupState=true;native.actualStatusState=true;
        await studentDialog.getByRole('button',{name:'Приказ',exact:true}).click();
        const next=studentDialog.getByRole('menuitem',{name:step.next,exact:true});
        try{await next.waitFor({timeout:3000});}catch{}
        native.nextAction={title:step.next,visible:await next.count()===1};
        await writeFile(privatePath,JSON.stringify(progress,null,2));
        assert(native.nextAction.visible,`${step.name}: next workflow action does not reflect the committed student status`);
        await studentDialog.getByRole('button',{name:'Приказ',exact:true}).click();
        await studentDialog.getByRole('button',{name:'Закрыть',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('[role=dialog]'));
      }
    }finally{
      const cleanup=await context.request.post(`${origin}/api/v1/auth/logout`,{headers:{Origin:origin,Authorization:`Bearer ${login.access_token}`,'X-CSRF-Token':login.csrf_token}});
      evidence.authCleanupStatus=cleanup.status();assert([204,401].includes(cleanup.status()));await context.close();
    }
  } else if (phase === 'stage2-workflow-retry') {
    const fixture=JSON.parse(await readFile(resolve(root,'.local/p12-browser-credentials.json'),'utf8'));
    const lookup=spawnSync(resolve(root,'.venv/Scripts/python.exe'),[resolve(root,'frontend/tests/integration/stage2-fixture.py'),'workflows'],{encoding:'utf8',cwd:root});
    assert.equal(lookup.status,0,lookup.stderr);const choices=JSON.parse(lookup.stdout);
    evidence.database=fixture.database;evidence.workflow={role:'admin',attempts:[]};
    const context=await browser.newContext({viewport:{width:1440,height:900}}),page=await context.newPage();
    watch(page,'admin');await page.goto(origin);const login=await authenticate(page,fixture.accounts.find(a=>a.role==='admin'));
    let release;
    try {
      await page.locator('[role=tab][href="/students"]').click();await settleTable(page);
      await page.getByRole('button',{name:'Зачислить',exact:true}).click();
      const dialog=page.getByRole('dialog',{name:'Зачисление студента',exact:true});
      const suffix=Date.now().toString(36),lastName=`P12Stage2_${suffix}`;
      for(const [name,value] of [['last_name',lastName],['first_name','Browser'],['middle_name','Before'],['birth_date','2003-01-01'],['record_book',`P12F${suffix}`],['order_number',`P12F-${suffix}-E1`]])
        await dialog.locator(`#wf-${name}`).fill(value);
      await dialog.locator('#wf-gender').selectOption('M');
      const choose=async(name,label)=>{
        await dialog.locator(`#wf-${name}`).locator('..').click();
        await dialog.locator(`#wf-${name}`).fill(label);
        await dialog.getByRole('option').filter({has:page.getByText(label,{exact:true})}).click();
      };
      await choose('group_name',choices.groups[0].name);await choose('funding',choices.funding);await choose('signed_by',choices.signer.label);
      let seen,reject;const observed=new Promise((resolve,fail)=>{seen=resolve;reject=fail;}),released=new Promise(resolve=>{release=resolve;});
      const attempts=evidence.workflow.attempts;
      await page.route('**/api/v1/workflows/enroll_student',async route=>{
        const request=route.request(),headers=await request.allHeaders();
        attempts.push({key:headers['idempotency-key'],body:request.postDataJSON()});
        if(attempts.length<=2)return route.abort('connectionfailed');
        try {
          const response=await route.fetch();const body=await response.json();
          await writeFile(resolve(root,'.local/p12-browser-stage2-workflows.json'),JSON.stringify({database:fixture.database,last_name:lastName,choices,attempts,status:response.status(),result:body},null,2));
          assert.equal(response.status(),200);evidence.workflow.result=body;seen();await released;await route.fulfill({response});
        } catch(error){reject(error);await route.abort('connectionfailed');}
      });
      for(let i=0;i<2;i++) {
        await dialog.getByRole('button',{name:'Зачислить',exact:true}).click();
        await dialog.getByRole('alert').waitFor();await dialog.getByRole('button',{name:'Зачислить',exact:true}).waitFor();
        assert.equal(attempts.length,i+1);
      }
      assert.match(attempts[0].key,/^[0-9a-f-]{36}$/);assert.equal(attempts[0].key,attempts[1].key);assert.deepEqual(attempts[0].body,attempts[1].body);
      await dialog.locator('#wf-middle_name').fill('After');
      const timer=setTimeout(()=>reject(new Error('Actual workflow200 did not reach the timing gate')),30000);
      await dialog.getByRole('button',{name:'Зачислить',exact:true}).click();await observed.finally(()=>clearTimeout(timer));
      assert.equal(attempts.length,3);assert.notEqual(attempts[2].key,attempts[1].key);
      assert.deepEqual(attempts[2].body,{...attempts[1].body,middle_name:'After'});
      assert(await dialog.locator('#wf-middle_name').isDisabled());assert(await dialog.locator('#wf-gender').isDisabled());
      await page.keyboard.press('Escape');await dialog.getByRole('button',{name:'Закрыть',exact:true}).click();assert.equal(await dialog.count(),1);
      await dialog.locator('form').evaluate(form=>{form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
      assert.equal(attempts.length,3);release();await dialog.waitFor({state:'detached'});
      const headers={Origin:origin,Authorization:`Bearer ${login.access_token}`,'X-CSRF-Token':login.csrf_token};
      const response=await context.request.get(`${origin}/api/v1/resources/student?student_id=${evidence.workflow.result.student_id}`,{headers});
      assert.equal(response.status(),200);const students=(await response.json()).items;assert.equal(students.length,1);
      assert.equal(students[0].group_id,choices.groups[0].group_id);assert.equal(evidence.workflow.result.status,'applied');
      await page.getByRole('textbox',{name:/^Поиск:/}).fill(lastName);
      await page.locator(`.table-card tr[data-k="${students[0].student_id}"]`).waitFor();
      evidence.workflow={...evidence.workflow,networkFaults:2,unchangedBodySameKey:true,editedBodyNewKey:true,actualNative200:true,
        timingGate:'held actualenroll200',busyFields:true,closeWhileBusyBlocked:true,duplicateSubmitBlocked:true,tableUpdated:true};
    } finally {
      release?.();const cleanup=await context.request.post(`${origin}/api/v1/auth/logout`,{headers:{Origin:origin,Authorization:`Bearer ${login.access_token}`,'X-CSRF-Token':login.csrf_token}});
      evidence.authCleanupStatus=cleanup.status();assert([204,401].includes(cleanup.status()));await context.close();
    }
  } else if (phase === 'stage2-forms') {
    const fixture=JSON.parse(await readFile(resolve(root,'.local/p12-browser-credentials.json'),'utf8'));
    const owned=JSON.parse(await readFile(resolve(root,'.local/p12-browser-stage2-fixture.json'),'utf8'));
    assert.equal(owned.database,fixture.database);evidence.database=fixture.database;evidence.forms={};
    const context=await browser.newContext({viewport:{width:1440,height:900}}),page=await context.newPage();
    watch(page,'admin');await page.goto(origin);const login=await authenticate(page,fixture.accounts.find(a=>a.role==='admin'));
    try {
      const employee=owned.employee,changedRate=Number(employee.employment_rate)===0.75?'1.00':'0.75';
      const employeeState=()=>{
        const result=spawnSync(resolve(root,'.venv/Scripts/python.exe'),[resolve(root,'frontend/tests/integration/stage2-fixture.py'),'employee'],{encoding:'utf8',cwd:root});
        assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);
      };
      await page.locator('[role=tab][href="/employees"]').click();await settleTable(page);
      const openEmployee=async()=>{await page.locator(`.table-card tr[data-k="${employee.employee_id}"]`).click();await page.locator('[data-field="employment_rate"] input').waitFor();};
      const dialog=()=>page.getByRole('dialog').filter({has:page.locator('[data-field="employment_rate"]')});
      const rate=()=>dialog().locator('[data-field="employment_rate"] input');
      await openEmployee();await rate().fill(changedRate);await page.keyboard.press('Escape');
      await page.getByRole('dialog',{name:'Сохранить изменения?',exact:true}).waitFor();
      await page.keyboard.press('Escape');assert.equal(await page.getByRole('dialog').count(),1);assert.equal(await rate().inputValue(),changedRate);
      await page.keyboard.press('Escape');await page.getByRole('button',{name:'Не сохранять',exact:true}).click();
      await page.waitForFunction(()=>!document.querySelector('[role=dialog]'));
      assert.equal(Number(employeeState().employment_rate),Number(employee.employment_rate));
      await openEmployee();await rate().fill('0.10');await dialog().getByRole('button',{name:'Сохранить',exact:true}).click();
      await dialog().getByRole('alert').filter({hasText:'Допустимо от'}).waitFor();
      assert.equal(evidence.requests.filter(r=>r.method==='PATCH').length,0);await rate().fill(changedRate);
      await dialog().locator('[data-field="linked.last_name"] input').fill('P12Stage2_Last');
      let observe,release;const observed=new Promise(resolve=>{observe=resolve;}),released=new Promise(resolve=>{release=resolve;});
      let personAttempts=0,employeeAttempts=0;
      await page.route('**/api/v1/resources/person?*',async route=>{
        if(route.request().method()!=='PATCH')return route.continue();
        personAttempts++;const response=await route.fetch();assert.equal(response.status(),200);observe();await released;await route.fulfill({response});
      });
      await page.route('**/api/v1/resources/employee?*',async route=>{
        if(route.request().method()!=='PATCH')return route.continue();
        employeeAttempts++;if(employeeAttempts===1)return route.abort('connectionfailed');return route.continue();
      });
      await dialog().getByRole('button',{name:'Сохранить',exact:true}).click();await observed;
      await dialog().getByRole('button',{name:'Сохраняем…',exact:true}).waitFor();
      assert(await rate().isDisabled());assert(await dialog().locator('[data-field="linked.last_name"] input').isDisabled());
      await page.keyboard.press('Escape');await dialog().getByRole('button',{name:'Закрыть',exact:true}).click();assert.equal(await page.getByRole('dialog').count(),1);
      await dialog().locator('form').evaluate(form=>{form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
      assert.equal(personAttempts,1);assert.equal(employeeAttempts,0);
      const partial=employeeState();assert.equal(partial.person.last_name,'P12Stage2_Last');assert.equal(Number(partial.employment_rate),Number(employee.employment_rate));
      release();await dialog().getByRole('alert').filter({hasText:'ФИО уже сохранено. Реквизиты сотрудника не сохранены:'}).waitFor();
      assert.equal(await rate().inputValue(),changedRate);
      await dialog().getByRole('button',{name:'Сохранить',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('[role=dialog]'));
      assert.equal(personAttempts,1);assert.equal(employeeAttempts,2);
      const saved=employeeState();assert.equal(saved.person.last_name,'P12Stage2_Last');assert.equal(Number(saved.employment_rate),Number(changedRate));
      assert.equal(saved.person.first_name,owned.person.first_name);assert.equal(saved.person.middle_name,owned.person.middle_name);
      evidence.forms.employee={dirtyEscape:true,escapeOnlyTopModal:true,discardNoWrite:true,validationNoRequest:true,
        timingGate:'held actualpersonPATCH200',networkFault:'employeePATCH aborted before server',busyInputs:true,closeWhileBusyBlocked:true,
        duplicateSubmitBlocked:true,partialSavedVisible:true,personAttempts,employeeAttempts,retryExactState:true};
      await page.unroute('**/api/v1/resources/person?*');await page.unroute('**/api/v1/resources/employee?*');
      await page.locator('[role=tab][href="/students"]').click();await settleTable(page);
      await page.getByRole('button',{name:'Зачислить',exact:true}).click();
      const enrollment=page.getByRole('dialog',{name:'Зачисление студента',exact:true});
      await enrollment.getByRole('button',{name:'Зачислить',exact:true}).click();
      assert(await enrollment.getByRole('alert').count()>0);
      await enrollment.locator('#wf-last_name').fill('P12Stage2');await page.keyboard.press('Escape');
      await page.getByRole('dialog',{name:'Провести приказ?',exact:true}).waitFor();await page.keyboard.press('Escape');
      assert.equal(await enrollment.locator('#wf-last_name').inputValue(),'P12Stage2');
      await page.keyboard.press('Escape');await page.getByRole('button',{name:'Не сохранять',exact:true}).click();
      await page.waitForFunction(()=>!document.querySelector('[role=dialog]'));
      evidence.forms.workflow={requiredValidation:true,dirtyEscape:true,escapeOnlyTopModal:true,discardNoWrite:true};
    } finally {
      const cleanup=await context.request.post(`${origin}/api/v1/auth/logout`,{headers:{Origin:origin,Authorization:`Bearer ${login.access_token}`,'X-CSRF-Token':login.csrf_token}});
      evidence.authCleanupStatus=cleanup.status();assert([204,401].includes(cleanup.status()));await context.close();
    }
  } else if (phase === 'stage2-olap' || phase === 'stage2-controls') {
    const fixture=JSON.parse(await readFile(resolve(root,'.local/p12-browser-credentials.json'),'utf8'));
    const owned=JSON.parse(await readFile(resolve(root,'.local/p12-browser-stage2-fixture.json'),'utf8'));
    assert.equal(owned.database,fixture.database); evidence.database=fixture.database;
    const context=await browser.newContext({viewport:{width:1440,height:900}}), page=await context.newPage();
    watch(page,'teacher'); await page.goto(origin);
    const login=await authenticate(page,fixture.accounts.find(a=>a.role==='teacher'));
    try {
    const actualReports=new Map(), lookups=new Map();
    page.on('response',response=>{
      const url=new URL(response.url());
      if (response.ok() && url.pathname==='/api/v1/olap') actualReports.set(url.searchParams.get('mode'),response.json());
      if (response.ok() && url.pathname.startsWith('/api/v1/resources/')) lookups.set(url.pathname.split('/').at(-1),response.json());
    });
    const reportAfter=async (action,mode,field,value)=>{
      const pending=page.waitForResponse(r=>responseFor('/olap')(r) && new URL(r.url()).searchParams.get('mode')===mode &&
        (!field || new URL(r.url()).searchParams.get(field)===String(value)));
      await action(); const report=await (await pending).json();
      await page.locator('.table-meta').filter({hasText:`результатов ${report.total.results}`}).waitFor();
      return report;
    };
    const initial=await reportAfter(()=>page.locator('[role=tab][href="/olap"]').click(),'rollup-group');
    const role={role:'teacher',fixture:owned.assignments,modes:[],filters:[],localControls:{},foreign:[]}; evidence.roles.push(role);
    role.selectorLabels=await page.locator('.ops .filters label').evaluateAll(labels=>labels.map(label=>({caption:label.querySelector('span')?.textContent,text:label.textContent})));
    const select=label=>page.locator('.ops .filters label').filter({has:page.getByText(label,{exact:true})}).locator('select');
    for (const [mode,label] of phase==='stage2-controls' ? [] : modes) {
      let report=mode==='rollup-group' ? initial : await reportAfter(()=>page.getByRole('button',{name:label,exact:true}).click(),mode);
      if (mode==='slice-group' || mode==='drilldown-group') {
        const group=String(owned.assignments[0].group_id);
        if (await select('Группа').inputValue() !== group)
          report=await reportAfter(()=>select('Группа').selectOption(group),mode,'group_id',group);
      }
      if (mode==='slice-discipline') {
        const discipline=String(owned.assignments[0].discipline_id);
        report=await reportAfter(()=>select('Дисциплина').selectOption(discipline),mode,'discipline_id',discipline);
      }
      assert(report.total.results>0,`${mode}: positive own teacher scope`);
      await checkTable(page,report); controls.push({role:'teacher',report});
      if (mode.startsWith('rollup-')) {
        const min=Math.min(...report.scale.map(b=>b.min_points)),max=Math.max(...report.scale.map(b=>b.max_points));
        const percent=value=>max===min?50:Math.max(0,Math.min(100,(Number(value)-min)/(max-min)*100));
        if (mode==='rollup-semester') {
          const circles=await page.locator('.line-chart .pt circle').evaluateAll(nodes=>nodes.map(n=>({cx:Number(n.getAttribute('cx')),cy:Number(n.getAttribute('cy'))})));
          const rows=[...report.rows].sort((a,b)=>a.semester-b.semester);
          assert.equal(circles.length,rows.filter(r=>r.avg!=null).length);
          let index=0;
          rows.forEach((row,i)=>{if(row.avg!=null){const circle=circles[index++];assert(Math.abs(circle.cx-(rows.length===1?485:94+i*792/(rows.length-1)))<1e-8);assert(Math.abs(circle.cy-(26+170*(1-percent(row.avg)/100)))<1e-8);}});
        } else {
          const dots=await page.locator('.dp-dot').evaluateAll(nodes=>nodes.map(n=>parseFloat(n.style.left)));
          const rows=[...report.rows].sort((a,b)=>Number(b.avg)-Number(a.avg)).filter(r=>r.avg!=null);
          assert.equal(dots.length,rows.length);
          role.chartPositions={mode,positions:dots.map((dot,i)=>({actual:dot,expected:percent(rows[i].avg)}))};
          dots.forEach((dot,i)=>assert(Math.abs(dot-percent(rows[i].avg))<0.0001));
        }
      }
      role.modes.push({mode,rows:report.rows.length,results:report.total.results,debts:report.total.debts,rendered:true,chartPosition:mode.startsWith('rollup-')});
    }
    let report=phase==='stage2-controls' ? initial : await reportAfter(()=>page.getByRole('button',{name:'Roll-up по группе',exact:true}).click(),'rollup-group');
    const baseline=report;
    const keys=()=>page.locator('.table-card tr[data-k]').evaluateAll(rows=>rows.map(r=>r.dataset.k));
    const checkKeys=async expected=>{
      await page.waitForFunction(expected=>JSON.stringify([...document.querySelectorAll('.table-card tr[data-k]')].map(row=>row.dataset.k))===JSON.stringify(expected),expected);
      assert.deepEqual(await keys(),expected);
    };
    await page.getByRole('textbox',{name:'Поиск: Группа',exact:true}).fill(baseline.rows[0].name);
    await checkKeys([String(baseline.rows[0].group_id)]);
    await page.getByRole('button',{name:'Очистить поиск',exact:true}).click();
    const header=page.getByRole('columnheader',{name:'Средний балл',exact:false});
    const cmp=(a,b)=>Number(a.avg==null)-Number(b.avg==null) || Number(a.avg)-Number(b.avg);
    await header.click(); assert.equal(await header.getAttribute('aria-sort'),'ascending');
    await checkKeys([...baseline.rows].sort(cmp).map(r=>String(r.group_id)));
    await header.click(); assert.equal(await header.getAttribute('aria-sort'),'descending');
    await checkKeys([...baseline.rows].sort((a,b)=>-cmp(a,b)).map(r=>String(r.group_id)));
    await header.click(); assert.equal(await header.getAttribute('aria-sort'),'none');
    await checkKeys(baseline.rows.map(r=>String(r.group_id)));
    await page.getByRole('button',{name:'Фильтры',exact:true}).click();
    const threshold=Math.max(...baseline.rows.map(r=>Number(r.avg)));
    await page.getByRole('spinbutton',{name:'Средний балл: от',exact:true}).fill(String(threshold));
    await checkKeys(baseline.rows.filter(r=>r.avg!=null && Number(r.avg)>=threshold).map(r=>String(r.group_id)));
    await page.evaluate(()=>{
      window.__p12ResetEvents=[];
      for(const type of ['mousedown','mouseup','click']) document.addEventListener(type,event=>{
        const target=event.target.closest('button,th,.ff');
        window.__p12ResetEvents.push({type,tag:target?.tagName,text:target?.textContent.slice(0,80),x:event.clientX,y:event.clientY});
      },true);
    });
    const reset=page.getByRole('button',{name:'Сбросить всё',exact:true});
    role.resetBefore=await reset.boundingBox();
    await reset.click();
    role.resetAfter={events:await page.evaluate(()=>window.__p12ResetEvents),button:await reset.count() ? await reset.boundingBox() : null,panel:await page.locator('.fpanel').count(),rows:await keys()};
    await checkKeys(baseline.rows.map(r=>String(r.group_id)));
    await page.getByRole('button',{name:'Фильтры',exact:true}).click();
    assert.equal(await page.locator('.fpanel').count(),1);
    await header.click();await checkKeys([...baseline.rows].sort(cmp).map(r=>String(r.group_id)));
    assert.equal(await header.getAttribute('aria-sort'),'ascending');assert.equal(await page.locator('.fpanel').count(),0);
    role.localControls={search:true,numericFilter:true,sortAscending:true,sortDescending:true,sortReset:true,outsideHeaderAction:true};
    const first=owned.assignments[0];
    for (const [label,field,value] of [['Группа','group_id',first.group_id],['Дисциплина','discipline_id',first.discipline_id],['Семестр','semester',first.semester]]) {
      report=await reportAfter(()=>select(label).selectOption(String(value)),'rollup-group',field,value);
      await checkTable(page,report); controls.push({role:'teacher',report}); role.filters.push({field,value,results:report.total.results});
    }
    const statuses=(await lookups.get('student_status')).items;
    for (const status of statuses) {
      report=await reportAfter(()=>select('Статус студента').selectOption(String(status.status_id)),'rollup-group','status_id',status.status_id);
      await checkTable(page,report); controls.push({role:'teacher',report}); role.filters.push({field:'status_id',value:status.status_id,results:report.total.results});
    }
    const headers={Origin:origin,Authorization:`Bearer ${login.access_token}`};
    for (const mode of ['slice-group','drilldown-group','cross-group-semester','dice']) {
      const response=await context.request.get(`${origin}/api/v1/olap?mode=${mode}&group_id=${owned.foreign_group_id}`,{headers});
      if(mode==='drilldown-group'){assert.equal(response.status(),404);role.foreign.push({mode,status:404});}
      else {assert.equal(response.status(),200);const denied=await response.json();assert.equal(denied.total.results,0);assert.equal(denied.total.debts,0);assert.equal(denied.rows.length,0);role.foreign.push({mode,status:200,scopedEmpty:true});}
    }
    assert(!await select('Группа').locator(`option[value="${owned.foreign_group_id}"]`).count());
    await select('Группа').evaluate((control,id)=>control.add(new Option('__forged_foreign_scope__',String(id))),owned.foreign_group_id);
    const forged=await reportAfter(()=>select('Группа').selectOption(String(owned.foreign_group_id)),'rollup-group','group_id',owned.foreign_group_id);
    assert.equal(forged.total.results,0);assert.equal(forged.total.debts,0);assert.equal(forged.rows.length,0);
    await page.locator('.table-card .empty').filter({hasText:'Ничего не найдено'}).waitFor();role.foreign.push({mode:'actualDOM-forged-selector',scopedEmpty:true});
    await signout(page);
    } finally {
      await context.request.post(`${origin}/api/v1/auth/logout`,{headers:{Origin:origin,Authorization:`Bearer ${login.access_token}`,'X-CSRF-Token':login.csrf_token}});
      await context.close();
    }
  } else {
    const fixture = JSON.parse(await readFile(resolve(root,'.local/p12-browser-credentials.json'),'utf8'));
    assert(fixture.database.startsWith('deanery_p12_ui_') && fixture.head === '0039_scope_check_latency');
    assert.equal(fixture.accounts.length, 5);
    evidence.database = fixture.database;
    for (const account of fixture.accounts) {
      if (selectedRoles && !selectedRoles.includes(account.role)) continue;
      if (phase === 'discipline' && account.role !== 'admin') continue;
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await context.newPage(); watch(page, account.role);
      const reports = new Map();
      const lookups = new Map();
      page.on('response', response => {
        const url = new URL(response.url());
        if (url.pathname === '/api/v1/olap' && response.ok()) reports.set(url.searchParams.get('mode'), response.json());
        if (url.pathname.startsWith('/api/v1/resources/') && response.ok()) lookups.set(url.pathname.slice('/api/v1/resources/'.length),response.json());
      });
      await page.goto(origin); await loggedOut(page);
      await page.getByLabel('Логин', {exact:true}).fill(account.login);
      await page.getByLabel('Пароль', {exact:true}).fill(account.password);
      const loginPromise = page.waitForResponse(responseFor('/auth/login'));
      const mePromise = page.waitForResponse(r => new URL(r.url()).pathname === '/api/v1/auth/me');
      const schemaPromise = page.waitForResponse(r => new URL(r.url()).pathname === '/api/v1/schema');
      await page.getByRole('button', {name:'Войти',exact:true}).click();
      const login = await (await loginPromise).json();
      const meResponse = await mePromise; assert.equal(meResponse.status(),200,`${account.role}: me status`);
      const me = await meResponse.json(); assert.deepEqual(me.roles,[account.role]);
      const schemaResponse = await schemaPromise; assert.equal(schemaResponse.status(),200,`${account.role}: schema status`);
      const schema = (await schemaResponse.json()).resources; assert(schema,`${account.role}: schema resources missing`);
      await loggedIn(page);
      const role = { role:account.role, visibleTabs:[], modes:[], reload:false, twoTabs:false, logout:false };
      evidence.roles.push(role);
      for (const [path,title,view] of tabs) {
        if (phase === 'discipline' && path !== 'olap') continue;
        const visible = !view || !!schema[view];
        const tab = page.locator(`[role=tab][href="/${path}"]`);
        assert.equal(await tab.count(), visible ? 1 : 0);
        if (!visible) continue;
        await tab.click(); await page.getByRole('heading',{name:title,exact:true,level:1}).waitFor();
        role.visibleTabs.push(path);
      }
      for (const [mode,label] of modes) {
        if (phase === 'discipline' && mode !== 'slice-discipline') continue;
        if (phase === 'stage1') {
          for (const lookup of ['study_group','discipline','student_status']) {
            if (!lookups.has(lookup)) await page.waitForResponse(responseFor(`/resources/${lookup}`));
            await lookups.get(lookup);
          }
          if ((mode === 'slice-group' || mode === 'drilldown-group') && !(await lookups.get('study_group')).items.length) {
            await page.getByRole('button',{name:label,exact:true}).click();
            await page.locator('.ops .hint').filter({hasText:'Нет доступных групп'}).waitFor();
            role.modes.push({mode,emptyScope:true,requiredSelection:true}); continue;
          }
        }
        const pendingReport = reports.get(mode) ?? page.waitForResponse(r => responseFor('/olap')(r) && new URL(r.url()).searchParams.get('mode') === mode).then(r=>r.json());
        await page.getByRole('button',{name:label,exact:true}).click();
        const report = await pendingReport;
        await page.locator('.table-meta').filter({hasText:`результатов ${report.total.results}`}).waitFor();
        assert.equal(report.mode,mode); assert(Array.isArray(report.rows)); assert(report.total && Array.isArray(report.scale));
        role.modes.push({mode, rows:report.rows.length, results:report.total.results, debts:report.total.debts});
        if (phase === 'stage1') { await checkTable(page,report); controls.push({role:account.role,report}); }
      }
      let second;
      if (phase === 'baseline' || phase === 'stage1') {
        await page.reload(); await loggedIn(page); role.reload = true;
        second = await context.newPage(); watch(second,account.role);
        await second.goto(origin); await loggedIn(second);
        await Promise.all([page.reload(),second.reload()]); await Promise.all([loggedIn(page),loggedIn(second)]); role.twoTabs = true;
      }
      if (phase === 'stage1') {
        const schemaChecks = await Promise.all(Array.from({length:4},()=>context.request.get(`${origin}/api/v1/schema`,{headers:{Authorization:`Bearer ${login.access_token}`}})));
        role.concurrentSchemaStatuses = schemaChecks.map(response=>response.status());
        assert.deepEqual(role.concurrentSchemaStatuses,[200,200,200,200],`${account.role}: concurrent schema`);
      }
      if (account.role === 'admin') await page.screenshot({path:resolve(root,`.nelson/missions/2026-10-11_065347_b2445e93/task${phase === 'stage1' ? 12 : 8}-react-olap.png`)});
      await page.locator('.avatar-btn').click(); await page.getByRole('menuitem',{name:'Выйти'}).click();
      await loggedOut(page); if (second) await loggedOut(second); role.logout = true;
      assert.equal(await page.evaluate(()=>Object.keys(sessionStorage).filter(k=>k.startsWith('deanery.chat.')).length),0);
      if (phase === 'stage1') {
        const revoked = await context.request.get(`${origin}/api/v1/resources/discipline`,{headers:{Authorization:`Bearer ${login.access_token}`}});
        role.revokedStatus = revoked.status(); role.revokedCode = (await revoked.json())?.error?.code;
        assert.equal(role.revokedStatus,401,`${account.role}: post-logout exact issued access`);
      }
      await context.close();
      console.log(JSON.stringify({role:role.role,tabs:role.visibleTabs.length,modes:role.modes.length,reload:role.reload,twoTabs:role.twoTabs,logout:role.logout}));
    }
  }
  assert.equal(evidence.errors.length,0,JSON.stringify(evidence.errors));
  evidence.passed = true;
} catch (error) {
  evidence.passed = false; evidence.failure = error.message.slice(0,700); throw error;
} finally {
  await Promise.all(diagnostics);
  if (controls.length) {
    const result = spawnSync(resolve(root,'.venv/Scripts/python.exe'),[resolve(root,'frontend/tests/integration/olap-control.py')],{input:JSON.stringify({database:evidence.database,encoding_probe:'\u042f\u0451',checks:controls}),encoding:'utf8',cwd:root,maxBuffer:8*1024*1024});
    if (result.status === 0) evidence.databaseControls = JSON.parse(result.stdout);
    else { evidence.passed=false; evidence.databaseControlFailure=(result.stderr || 'SQL control failed').slice(-1000); }
  }
  await writeFile(output, JSON.stringify(evidence,null,2));
  await browser.close();
  console.log(JSON.stringify({phase,passed:evidence.passed,roles:evidence.roles.length,requests:evidence.requests.length,errors:evidence.errors.length,evidence:output}));
  if (!evidence.passed) process.exitCode=1;
}
