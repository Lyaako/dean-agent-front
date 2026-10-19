// Real uploads, restricted Linux extraction and React preview; no inference.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export async function stage3Files({browser,root,origin,evidence,watch,authenticate}) {
  const native=(action,body={})=>{
    const r=spawnSync(resolve(root,'.venv/Scripts/python.exe'),[resolve(root,'frontend/tests/integration/file-ui-fixture.py'),action],
      {cwd:root,input:JSON.stringify(body),encoding:'utf8',maxBuffer:1024*1024});
    assert.equal(r.status,0,r.stderr.slice(-1200));return JSON.parse(r.stdout);
  };
  const credentials=JSON.parse(await readFile(resolve(root,'.local/p12-browser-credentials.json'),'utf8'));
  evidence.files={inventory:native('inventory'),uploads:[],provider_calls:0};
  const context=await browser.newContext({viewport:{width:1440,height:900}}),page=await context.newPage();
  watch(page,'file-admin');let tokens;
  const headers=()=>({Origin:origin,Authorization:`Bearer ${tokens.access_token}`,'X-CSRF-Token':tokens.csrf_token});
  try {
    await page.goto(origin);tokens=await authenticate(page,credentials.accounts.find(a=>a.role==='admin'));
    await page.locator('.chat .toggle').click();
    for(const filename of ['statement.txt','scanned-page-25.pdf','partial-image.docx']) {
      const uploaded=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/files'&&r.request().method()==='POST');
      await page.locator('.chat input[type=file]').setInputFiles(resolve(root,'.local/resume-file-assets',filename));
      const response=await uploaded;assert.equal(response.status(),201);
      const item={filename,...await response.json()};evidence.files.uploads.push(item);
      await writeFile(resolve(root,'.local/resume-file-assets/ui-uploads.json'),JSON.stringify(evidence.files.uploads,null,2));
      const thumb=page.locator('.chat .thumb').filter({has:page.locator('.name',{hasText:filename})});
      await thumb.locator('.thumb-busy').waitFor();
      const result=spawnSync('docker',['compose','-p','deanery-p12-ui-files','-f','compose.files.yaml','run','--rm','--no-deps','file-worker','python','-m','backend.file_worker','--once'],
        {cwd:root,env:{...process.env,FILES_WORKER_SECRET:'./.local/resume-ui-fileworker.json',P13_FILES_ROOT:'./.local/p12-ui-files'},encoding:'utf8',timeout:180000,maxBuffer:1024*1024});
      await writeFile(resolve(root,`.local/resume-file-assets/${filename}.worker.log`),result.stdout+result.stderr);
      assert.equal(result.status,0,'Real Linux file worker failed; private log retained');
      await thumb.locator('.thumb-busy').waitFor({state:'detached'});
      await page.waitForFunction(name=>[...document.querySelectorAll('.chat .thumb.st-ready .name')].some(e=>e.textContent===name),filename);
      assert.match(await thumb.locator('.attach-hint').innerText(),filename.endsWith('.docx')?/Частично извлечён/:/Текст извлечён/);
      await thumb.locator('.pic').click();const viewer=page.getByRole('dialog',{name:filename,exact:true});
      await viewer.locator(filename.endsWith('.pdf')?'.canvas-host canvas':'.doc').waitFor();
      assert.equal(await viewer.locator('.form-error').count(),0);
      if(filename.endsWith('.pdf'))assert.match(await viewer.innerText(),/Страница 1 из 25/);
      else assert.match(await viewer.locator('.doc').innerText(),/САПФИР-742/);
      await viewer.getByRole('button',{name:'Закрыть',exact:true}).click();
      const path=`/api/v1/files/${item.file_id}/versions/${item.version_id}/download`,download=await context.request.get(origin+path,{headers:headers()});
      assert.equal(download.status(),200);assert.equal(download.headers()['cache-control'],'private, no-store');
      assert.equal(createHash('sha256').update(await download.body()).digest('hex'),createHash('sha256').update(await readFile(resolve(root,'.local/resume-file-assets',filename))).digest('hex'));
      item.preview=true;item.protected_original_hash=true;
      if(filename!=='statement.txt'){await thumb.getByRole('button',{name:`Убрать ${filename}`,exact:true}).click();assert.equal(await thumb.count(),0);}
    }
    const caps=await context.request.get(origin+'/api/v1/agent/capabilities',{headers:headers()});assert.equal(caps.status(),200);
    assert.equal((await caps.json()).attachment_context.agent_status,'unavailable');
    // Ready extraction remains independent of unavailable model/worker capabilities.
    await page.locator('.chat .thumb.st-ready').waitFor();
    await page.getByRole('button',{name:'Отправить',exact:true}).click();
    await page.getByRole('alert').filter({hasText:'вложения'}).waitFor();assert.equal(await page.locator('.chat .thumb.st-ready').count(),1);
    await page.getByRole('button',{name:'Убрать statement.txt',exact:true}).click();
    evidence.files.unavailable_model_preserves_draft=true;
  } finally {
    if(tokens)assert.equal((await context.request.post(origin+'/api/v1/auth/logout',{headers:headers()})).status(),204);
    await context.close();
  }
  evidence.files.native=native('verify',{uploads:evidence.files.uploads});
}
