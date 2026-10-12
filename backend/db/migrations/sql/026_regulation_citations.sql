ALTER TABLE agent_backend.agent_run ADD COLUMN regulation_context JSONB NOT NULL DEFAULT
 '{"chunks":[],"read_chunk_ids":[],"provided_chunk_ids":[],"acknowledged_chunk_ids":[],"cited_chunk_ids":[],"warnings":[],"delivery_state":"pending"}'
 CHECK(jsonb_typeof(regulation_context)='object' AND octet_length(regulation_context::TEXT)<=40000);

-- All existing history, replay, lease and completion checks use this dependency closure.
CREATE OR REPLACE FUNCTION agent_backend.run_files_visible(p_run UUID,p_user INT) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
 WITH RECURSIVE dependencies(id) AS (
  SELECT p_run UNION
  SELECT value::UUID FROM dependencies d JOIN agent_backend.chat_message m ON m.metadata->>'run_id'=d.id::TEXT AND m.role='user'
   CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(m.metadata->'context_run_ids','[]'::JSONB)) value
 ) SELECT NOT EXISTS(SELECT 1 FROM dependencies d JOIN agent_backend.run_attachment a ON a.run_id=d.id
    WHERE NOT agent_backend.file_version_visible(a.version_id,p_user))
 AND NOT EXISTS(SELECT 1 FROM dependencies d JOIN agent_backend.agent_run r ON r.id=d.id
   CROSS JOIN LATERAL jsonb_array_elements(r.regulation_context->'chunks') c
   WHERE agent_backend.regulation_chunk_evidence((c->>'chunk_id')::UUID,p_user,(c->>'generation_id')::UUID) IS NULL
      OR agent_backend.regulation_chunk_evidence((c->>'chunk_id')::UUID,p_user,(c->>'generation_id')::UUID)->>'text_hash' IS DISTINCT FROM c->>'text_hash')
$$;

CREATE FUNCTION backend_api.run_regulation_scope(p_run UUID,p_worker UUID) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE r agent_backend.agent_run; a RECORD;
BEGIN
 r:=agent_backend.read_agent_run(p_run,p_worker);
 SELECT * INTO a FROM backend_api.account_snapshot(r.initiator_user_id);
 RETURN jsonb_build_object('is_admin',a.role_code='admin','institute_ids',COALESCE(to_jsonb(a.institute_ids),'[]'::JSONB));
END $$;

CREATE FUNCTION backend_api.rehydrate_regulation_candidates(p_run UUID,p_worker UUID,p_candidates JSONB) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE r agent_backend.agent_run; c JSONB; v JSONB; result JSONB:='[]'::JSONB;
BEGIN
 r:=agent_backend.read_agent_run(p_run,p_worker);
 IF jsonb_typeof(p_candidates) IS DISTINCT FROM 'array' OR jsonb_array_length(p_candidates)>12 OR octet_length(p_candidates::TEXT)>10000
  THEN RAISE EXCEPTION 'Invalid candidates' USING ERRCODE='22023'; END IF;
 FOR c IN SELECT * FROM jsonb_array_elements(p_candidates) LOOP
  v:=agent_backend.regulation_chunk_evidence((c->>'chunk_id')::UUID,r.initiator_user_id,(c->>'generation_id')::UUID);
  IF v IS NOT NULL AND v->>'version_id'=c->>'version_id' AND v->>'text_hash'=c->>'text_hash'
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(result) x WHERE x->>'chunk_id'=c->>'chunk_id') THEN
   result:=result||jsonb_build_array(v);
  END IF;
 END LOOP;
 RETURN result;
END $$;

CREATE FUNCTION backend_api.record_regulation_context(p_run UUID,p_worker UUID,p_action TEXT,p_chunks JSONB) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE r agent_backend.agent_run; c JSONB; v JSONB; saved JSONB; v_id TEXT; v_field TEXT;
BEGIN
 r:=agent_backend.lock_agent_run(p_run,p_worker);
 IF p_action NOT IN ('read','submitted','acknowledged','unknown') OR jsonb_typeof(p_chunks) IS DISTINCT FROM 'array'
  OR jsonb_array_length(p_chunks)>20 OR octet_length(p_chunks::TEXT)>12000 THEN
  RAISE EXCEPTION 'Invalid normative evidence' USING ERRCODE='22023'; END IF;
 saved:=r.regulation_context;
 FOR c IN SELECT * FROM jsonb_array_elements(p_chunks) LOOP
  IF c-ARRAY['regulation_id','version_id','chunk_id','generation_id','text_hash']<>'{}'::JSONB
    OR c->>'chunk_id' IS NULL OR c->>'text_hash' !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'Invalid normative chunk' USING ERRCODE='22023'; END IF;
  PERFORM 1 FROM agent_backend.regulation_version WHERE id=(c->>'version_id')::UUID FOR SHARE;
  v:=agent_backend.regulation_chunk_evidence((c->>'chunk_id')::UUID,r.initiator_user_id,(c->>'generation_id')::UUID);
  IF v IS NULL OR v->>'regulation_id' IS DISTINCT FROM c->>'regulation_id' OR v->>'version_id' IS DISTINCT FROM c->>'version_id'
   OR v->>'text_hash' IS DISTINCT FROM c->>'text_hash' THEN
   RAISE EXCEPTION 'Normative access changed' USING ERRCODE='P8008'; END IF;
  v_id:=c->>'chunk_id';
  IF NOT (saved->'chunks') @> jsonb_build_array(c) THEN
   IF p_action<>'read' OR EXISTS(SELECT 1 FROM jsonb_array_elements(saved->'chunks') x WHERE x->>'chunk_id'=v_id) THEN
    RAISE EXCEPTION 'Unknown normative chunk' USING ERRCODE='22023'; END IF;
   saved:=jsonb_set(saved,'{chunks}',saved->'chunks'||jsonb_build_array(c));
  END IF;
  v_field:=CASE p_action WHEN 'read' THEN 'read_chunk_ids' WHEN 'submitted' THEN 'provided_chunk_ids'
      WHEN 'acknowledged' THEN 'acknowledged_chunk_ids' END;
  IF p_action='acknowledged' AND NOT saved->'provided_chunk_ids' ? v_id THEN
    RAISE EXCEPTION 'Unsubmitted normative chunk' USING ERRCODE='22023'; END IF;
  IF v_field IS NOT NULL AND NOT saved->v_field ? v_id THEN
   saved:=jsonb_set(saved,ARRAY[v_field],saved->v_field||to_jsonb(v_id)); END IF;
  IF p_action IN ('submitted','acknowledged','unknown') THEN saved:=jsonb_set(saved,'{delivery_state}',to_jsonb(p_action)); END IF;
 END LOOP;
 IF jsonb_array_length(saved->'chunks')+(SELECT COALESCE(sum(jsonb_array_length(manifest->'chunks')),0)
    FROM agent_backend.run_attachment WHERE run_id=p_run)>20 THEN
  RAISE EXCEPTION 'Combined source budget exceeded' USING ERRCODE='22023'; END IF;
 UPDATE agent_backend.agent_run SET regulation_context=saved WHERE id=p_run;
END $$;

CREATE FUNCTION agent_backend.regulation_label(p_text TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT regexp_replace(replace(replace(COALESCE(p_text,''),chr(10),' '),chr(13),' '),'([\\`*_{}\[\]()<>#!|])','\\\1','g')
$$;

CREATE FUNCTION agent_backend.finalize_regulation_answer(r agent_backend.agent_run,p_answer TEXT) RETURNS TEXT
LANGUAGE plpgsql SET search_path=pg_catalog,deanery AS $$
DECLARE answer TEXT:=p_answer; matched TEXT[]; c JSONB; v JSONB; label TEXT; link TEXT; context JSONB;
BEGIN
 SELECT regulation_context INTO context FROM agent_backend.agent_run WHERE id=r.id;
 -- Raw/encoded model URLs are not citations. Python canonicalizes encodings first.
 answer:=regexp_replace(answer,'https?://[^\s)<>]+','Источник не подтверждён','gi');
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

ALTER FUNCTION agent_backend.finalize_attachment_answer(agent_backend.agent_run,TEXT) RENAME TO finalize_file_answer;
CREATE FUNCTION agent_backend.finalize_attachment_answer(r agent_backend.agent_run,p_answer TEXT) RETURNS JSONB
LANGUAGE plpgsql SET search_path=pg_catalog,deanery AS $$
BEGIN
 RETURN agent_backend.finalize_file_answer(r,agent_backend.finalize_regulation_answer(r,p_answer));
END $$;

CREATE OR REPLACE FUNCTION backend_api.finish_agent_run(p_run UUID,p_worker UUID,p_answer TEXT,p_error TEXT DEFAULT NULL) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE r agent_backend.agent_run; v_error TEXT:=p_error;
BEGIN
 SELECT * INTO r FROM agent_backend.agent_run WHERE id=p_run FOR UPDATE;
 IF NOT FOUND OR p_worker IS NULL OR r.lease_owner IS DISTINCT FROM p_worker OR r.session_id IS NULL THEN
  RAISE EXCEPTION 'Lease lost' USING ERRCODE='P8009'; END IF;
 IF r.finished_at IS NOT NULL THEN
  IF NOT agent_backend.run_files_visible(r.id,r.initiator_user_id) THEN
   RAISE EXCEPTION 'Source access changed' USING ERRCODE='P8008'; END IF;
  RETURN r.result;
 END IF;
 IF v_error IS NOT NULL AND v_error NOT IN ('agent_error','agent_unavailable','agent_protocol_error','agent_outcome_unknown',
  'agent_cancelled','agent_scope_changed','forbidden','agent_context_limit','agent_context_uncalibrated') THEN v_error:='agent_error'; END IF;
 IF length(p_answer)>64000 THEN v_error:='agent_protocol_error'; END IF;
 -- Publication and withdrawal serialize only this short final transaction, never provider calls.
 PERFORM 1 FROM agent_backend.regulation_version v WHERE v.id IN (
  WITH RECURSIVE dependencies(id) AS (
   SELECT p_run UNION SELECT value::UUID FROM dependencies d
   JOIN agent_backend.chat_message m ON m.metadata->>'run_id'=d.id::TEXT AND m.role='user'
   CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(m.metadata->'context_run_ids','[]'::JSONB)) value)
  SELECT (c->>'version_id')::UUID FROM dependencies d JOIN agent_backend.agent_run ar ON ar.id=d.id
  CROSS JOIN LATERAL jsonb_array_elements(ar.regulation_context->'chunks') c) ORDER BY v.id FOR SHARE;
 BEGIN
  PERFORM agent_backend.validate_agent_run(r,p_worker);
 EXCEPTION WHEN SQLSTATE 'P8009' THEN v_error:='agent_outcome_unknown';
  WHEN SQLSTATE 'P8007' THEN v_error:='agent_cancelled';
  WHEN SQLSTATE 'P8008' THEN v_error:='agent_scope_changed';
  WHEN SQLSTATE '42501' THEN v_error:='forbidden';
 END;
 UPDATE agent_backend.agent_run SET regulation_context=jsonb_set(regulation_context,'{delivery_state}','"unknown"'::JSONB)
  WHERE id=p_run AND regulation_context->>'delivery_state'='submitted';
 RETURN agent_backend.end_agent_run(p_run,p_answer,v_error);
END $$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA agent_backend FROM PUBLIC;
REVOKE ALL ON FUNCTION backend_api.run_regulation_scope(UUID,UUID),backend_api.rehydrate_regulation_candidates(UUID,UUID,JSONB),
 backend_api.record_regulation_context(UUID,UUID,TEXT,JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION backend_api.run_regulation_scope(UUID,UUID),backend_api.rehydrate_regulation_candidates(UUID,UUID,JSONB),
 backend_api.record_regulation_context(UUID,UUID,TEXT,JSONB) TO backend_executor;
