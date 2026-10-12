-- Keep active-generation ranking, shared evidence budgets and all terminal paths consistent.

CREATE OR REPLACE FUNCTION backend_api.run_regulation_scope(p_run UUID,p_worker UUID) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE r agent_backend.agent_run; a RECORD;
BEGIN
 r:=agent_backend.read_agent_run(p_run,p_worker);
 SELECT * INTO a FROM backend_api.account_snapshot(r.initiator_user_id);
 RETURN jsonb_build_object('is_admin',a.role_code='admin','institute_ids',COALESCE(to_jsonb(a.institute_ids),'[]'::JSONB),
  'generation_ids',COALESCE((SELECT jsonb_agg(v.metadata->>'active_index_generation' ORDER BY v.id)
   FROM agent_backend.regulation_version v WHERE agent_backend.regulation_version_visible(v.id,r.initiator_user_id)), '[]'::JSONB));
END $$;

CREATE OR REPLACE FUNCTION backend_api.record_attachment_context(p_run UUID,p_worker UUID,p_action TEXT,p_chunks JSONB,p_limits JSONB DEFAULT '{}') RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE r agent_backend.agent_run; c JSONB; a agent_backend.run_attachment; v_field TEXT; v_id TEXT;
BEGIN
 r:=agent_backend.lock_agent_run(p_run,p_worker);
 IF p_action NOT IN ('selected','read','submitted','acknowledged','unknown','configure') OR jsonb_typeof(p_chunks)<>'array' OR jsonb_array_length(p_chunks)>20
    OR octet_length(p_chunks::TEXT)>40000 THEN RAISE EXCEPTION 'Invalid attachment evidence' USING ERRCODE='22023'; END IF;
 IF p_action='configure' THEN
  UPDATE agent_backend.run_attachment SET manifest=manifest||jsonb_build_object('limits',p_limits-'warnings',
    'warnings',COALESCE(p_limits->'warnings','[]'::JSONB)),updated_at=clock_timestamp() WHERE run_id=p_run;
  RETURN;
 END IF;
 FOR c IN SELECT * FROM jsonb_array_elements(p_chunks) LOOP
  IF c-ARRAY['file_id','version_id','chunk_id','page','block','block_end','start','end','source','quality','text_hash']<>'{}'::JSONB
    OR c->>'chunk_id' IS NULL OR c->>'text_hash' !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Invalid chunk' USING ERRCODE='22023'; END IF;
  SELECT * INTO a FROM agent_backend.run_attachment WHERE run_id=p_run AND version_id=(c->>'version_id')::UUID FOR UPDATE;
  IF NOT FOUND OR NOT agent_backend.file_version_visible(a.version_id,r.initiator_user_id)
    OR NOT EXISTS(SELECT 1 FROM agent_backend.file_version WHERE id=a.version_id AND file_id=(c->>'file_id')::UUID)
     THEN RAISE EXCEPTION 'File missing' USING ERRCODE='P0002'; END IF;
  v_id:=c->>'chunk_id';
  IF NOT (a.manifest->'chunks') @> jsonb_build_array(c) THEN
    IF p_action NOT IN ('selected','read') OR EXISTS(SELECT 1 FROM jsonb_array_elements(a.manifest->'chunks') known WHERE known->>'chunk_id'=v_id)
      THEN RAISE EXCEPTION 'Unknown or changed chunk' USING ERRCODE='22023'; END IF;
    a.manifest:=jsonb_set(a.manifest,'{chunks}',a.manifest->'chunks'||jsonb_build_array(c));
  END IF;
  IF p_action IN ('read','submitted','acknowledged') THEN
    v_field:=CASE p_action WHEN 'read' THEN 'read_chunk_ids' WHEN 'submitted' THEN 'provided_chunk_ids' ELSE 'acknowledged_chunk_ids' END;
    IF p_action='acknowledged' AND NOT a.manifest->'provided_chunk_ids' ? v_id THEN RAISE EXCEPTION 'Unsubmitted chunk' USING ERRCODE='22023'; END IF;
    IF NOT a.manifest->v_field ? v_id THEN a.manifest:=jsonb_set(a.manifest,ARRAY[v_field],a.manifest->v_field||to_jsonb(v_id)); END IF;
  END IF;
  IF p_action IN ('submitted','acknowledged','unknown') THEN a.manifest:=jsonb_set(a.manifest,'{delivery_state}',to_jsonb(p_action)); END IF;
  a.manifest:=a.manifest||jsonb_build_object('limits',p_limits-'warnings');
  UPDATE agent_backend.run_attachment SET manifest=a.manifest,context_state=CASE WHEN p_action IN ('submitted','acknowledged') THEN 'provided' ELSE context_state END,
      context_mode=CASE WHEN p_action IN ('submitted','acknowledged') THEN 'text' ELSE context_mode END,updated_at=clock_timestamp()
      WHERE run_id=p_run AND version_id=a.version_id;
 END LOOP;
 IF jsonb_array_length(r.regulation_context->'chunks')+(SELECT COALESCE(sum(jsonb_array_length(manifest->'chunks')),0) FROM agent_backend.run_attachment WHERE run_id=p_run)>20
    THEN RAISE EXCEPTION 'Combined source budget exceeded' USING ERRCODE='22023'; END IF;
END $$;

CREATE OR REPLACE FUNCTION agent_backend.end_agent_run(p_run UUID,p_answer TEXT,p_error TEXT) RETURNS JSONB
LANGUAGE plpgsql SET search_path=pg_catalog,deanery AS $$
DECLARE r agent_backend.agent_run; v_result JSONB; v_data JSONB; v_text TEXT; v_sequence BIGINT; v_event TEXT; v_safe JSONB;
BEGIN
    SELECT * INTO r FROM agent_backend.agent_run WHERE id=p_run FOR UPDATE;
    IF r.finished_at IS NOT NULL THEN RETURN r.result; END IF;
    IF r.session_id IS NULL THEN RAISE EXCEPTION 'Chat missing' USING ERRCODE='P8001'; END IF;
    IF p_error IS NULL THEN
        v_safe:=agent_backend.finalize_attachment_answer(r,COALESCE(p_answer,''));
        v_event:='done'; v_text:=v_safe->>'answer';
    ELSE
        v_event:='error';
        v_text:=CASE p_error WHEN 'agent_cancelled' THEN 'Запуск остановлен. Подготовленные предложения сохранены.'
            WHEN 'agent_scope_changed' THEN 'Права доступа изменились. Отправьте новый запрос.'
            WHEN 'forbidden' THEN 'Доступ отозван. Войдите снова.'
            WHEN 'agent_outcome_unknown' THEN 'Запуск прерван на сервере. Он не будет повторён автоматически.'
            WHEN 'agent_context_limit' THEN 'Контекст превышает окно модели. Сократите запрос или запросите отдельную страницу.'
            WHEN 'agent_context_uncalibrated' THEN 'Настройки модели изменились; необходима проверка бюджета контекста.'
            WHEN 'agent_unavailable' THEN 'Модель временно недоступна.' ELSE 'Агент не смог завершить запрос.' END;
    END IF;
    UPDATE agent_backend.run_attachment SET manifest=jsonb_set(manifest,'{delivery_state}','"unknown"'::JSONB) WHERE run_id=r.id AND manifest->>'delivery_state'='submitted';
    UPDATE agent_backend.agent_run SET regulation_context=jsonb_set(regulation_context,'{delivery_state}','"unknown"'::JSONB)
        WHERE id=r.id AND regulation_context->>'delivery_state'='submitted';
    v_result:=jsonb_build_object('run_id',r.id,'session_id',r.session_id,'answer',v_text,
        'attachment_context',agent_backend.attachment_manifest(r.id),'proposals',agent_backend.run_proposals(r.id),'tools_used',r.tools_used);
    v_data:=CASE WHEN p_error IS NULL THEN v_result ELSE jsonb_build_object('type',p_error,'message',v_text,
        'run_id',r.id,'session_id',r.session_id,'manifest',jsonb_build_object('attachment_context',v_result->'attachment_context','proposals',v_result->'proposals','tools_used',r.tools_used)) END;
    UPDATE agent_backend.agent_run SET status=CASE WHEN p_error IS NULL THEN 'succeeded' WHEN p_error='agent_cancelled' THEN 'cancelled' ELSE 'failed' END,
        result=v_result,error_code=p_error,finished_at=clock_timestamp(),lease_until=NULL,
        events=events||jsonb_build_array(jsonb_build_object('sequence',jsonb_array_length(events)+1,'event',v_event,'data',v_data)) WHERE id=r.id;
    UPDATE deanery.agent_request SET response_text=v_text,status=CASE WHEN p_error IS NULL THEN 'success' ELSE 'error' END,
        execution_ms=LEAST(2147483647,GREATEST(0,extract(epoch FROM (clock_timestamp()-r.created_at))*1000))::INT
        WHERE agent_request_id=r.agent_request_id;
    SELECT COALESCE(max(sequence),0)+1 INTO v_sequence FROM agent_backend.chat_message WHERE session_id=r.session_id;
    INSERT INTO agent_backend.chat_message(session_id,sequence,role,text,metadata)
        VALUES(r.session_id,v_sequence,CASE WHEN p_error IS NULL THEN 'agent' ELSE 'error' END,v_text,
            jsonb_build_object('run_id',r.id,'scope_signature',r.scope_signature));
    UPDATE agent_backend.chat_session SET updated_at=clock_timestamp() WHERE id=r.session_id;
    RETURN v_result;
END $$;

CREATE OR REPLACE FUNCTION agent_backend.finalize_regulation_answer(r agent_backend.agent_run,p_answer TEXT) RETURNS TEXT
LANGUAGE plpgsql SET search_path=pg_catalog,deanery AS $$
DECLARE answer TEXT:=p_answer; matched TEXT[]; c JSONB; v JSONB; label TEXT; link TEXT; context JSONB;
BEGIN
 SELECT regulation_context INTO context FROM agent_backend.agent_run WHERE id=r.id;
 -- Raw/encoded model URLs are not citations. Python canonicalizes encodings first.
 answer:=regexp_replace(answer,'(https?://|//|www\.)[^\s)<>]+','Источник не подтверждён','gi');
 FOR matched IN SELECT regexp_matches(answer,'\[\[regulation:([^]\r\n]+)\]\]','g') LOOP
  c:=NULL; v:=NULL;
  IF context->'acknowledged_chunk_ids' ? matched[1] THEN
   SELECT x INTO c FROM jsonb_array_elements(context->'chunks') x WHERE x->>'chunk_id'=matched[1];
   PERFORM 1 FROM agent_backend.regulation_version WHERE id=(c->>'version_id')::UUID FOR SHARE;
   v:=agent_backend.regulation_chunk_evidence((c->>'chunk_id')::UUID,r.initiator_user_id,(c->>'generation_id')::UUID);
  END IF;
  IF v IS NULL OR v->>'text_hash' IS DISTINCT FROM c->>'text_hash' THEN
   link:='Источник не подтверждён';
   context:=jsonb_set(context,'{warnings}',context->'warnings'||'["unverified_citation"]'::JSONB);
  ELSE
   label:=agent_backend.regulation_label(v->>'title')||' — '||agent_backend.regulation_label(v->>'source')||
    '; версия '||agent_backend.regulation_label(v->>'version_label')||
    CASE WHEN v->'locator'->>'page' IS NOT NULL THEN '; стр. '||agent_backend.regulation_label(v->'locator'->>'page')
         ELSE '; фрагмент '||agent_backend.regulation_label(COALESCE(v->'locator'->>'block','1')) END||
    CASE WHEN v->'locator'->>'point' IS NOT NULL THEN '; п. '||agent_backend.regulation_label(v->'locator'->>'point') ELSE '' END;
   link:=CASE WHEN v->>'source_url' ~ '^https?://[^[:space:]<>"\\]+$'
    THEN '['||label||']('||replace(replace(v->>'source_url','(','%28'),')','%29')||')' ELSE label END;
   IF NOT context->'cited_chunk_ids' ? matched[1] THEN
    context:=jsonb_set(context,'{cited_chunk_ids}',context->'cited_chunk_ids'||to_jsonb(matched[1])); END IF;
  END IF;
  answer:=replace(answer,'[[regulation:'||matched[1]||']]',link);
 END LOOP;
 IF context->>'delivery_state'='submitted' THEN context:=jsonb_set(context,'{delivery_state}','"unknown"'::JSONB); END IF;
 UPDATE agent_backend.agent_run SET regulation_context=context WHERE id=r.id;
 RETURN answer;
END $$;
