CREATE OR REPLACE FUNCTION agent_backend.proposal_file_access(p agent_backend.proposal,p_user INT) RETURNS BOOLEAN
LANGUAGE sql STABLE SET search_path=pg_catalog,deanery AS $$
 SELECT COALESCE(p.initiator_user_id=p_user OR
    (agent_backend.proposal_eligible(p,p_user) AND (p.assignee_user_id=p_user OR p.assignee_user_id IS NULL
     OR EXISTS(SELECT 1 FROM backend_api.account_snapshot(p_user) a WHERE a.role_code IN ('admin','director')))),FALSE)
$$;

CREATE OR REPLACE FUNCTION agent_backend.file_version_visible(p_version UUID,p_user INT) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
 SELECT EXISTS(SELECT 1 FROM deanery.app_user u WHERE u.user_id=p_user AND u.is_active) AND
  (EXISTS(SELECT 1 FROM agent_backend.file_version v JOIN agent_backend.file f ON f.id=v.file_id
          WHERE v.id=p_version AND f.owner_user_id=p_user)
   OR EXISTS(SELECT 1 FROM agent_backend.proposal_event e JOIN agent_backend.proposal p ON p.id=e.proposal_id
       CROSS JOIN LATERAL jsonb_array_elements(e.data->'chunks') c
       WHERE e.event_type='attachment_context' AND c->>'version_id'=p_version::TEXT AND agent_backend.proposal_file_access(p,p_user)))
$$;

CREATE FUNCTION agent_backend.run_files_visible(p_run UUID,p_user INT) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
 WITH RECURSIVE dependencies(id) AS (
  SELECT p_run UNION
  SELECT value::UUID FROM dependencies d JOIN agent_backend.chat_message m ON m.metadata->>'run_id'=d.id::TEXT AND m.role='user'
   CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(m.metadata->'context_run_ids','[]'::JSONB)) value
 ) SELECT NOT EXISTS(SELECT 1 FROM dependencies d JOIN agent_backend.run_attachment a ON a.run_id=d.id
    WHERE NOT agent_backend.file_version_visible(a.version_id,p_user))
$$;

CREATE FUNCTION agent_backend.message_files_visible(p_meta JSONB,p_scope TEXT,p_user INT) RETURNS BOOLEAN
LANGUAGE sql STABLE SET search_path=pg_catalog,deanery AS $$
 SELECT COALESCE(p_meta->>'scope_signature'=p_scope AND agent_backend.run_files_visible((p_meta->>'run_id')::UUID,p_user),FALSE)
$$;

CREATE FUNCTION agent_backend.run_file_metadata(p_run UUID) RETURNS JSONB
LANGUAGE sql STABLE SET search_path=pg_catalog,deanery AS $$
 SELECT COALESCE(jsonb_agg(jsonb_build_object('file_id',v.file_id,'version_id',v.id,'title',f.name,
  'filename',v.original_name,'mime',v.mime_type,'size',v.byte_size) ORDER BY v.id),'[]'::JSONB)
 FROM agent_backend.run_attachment a JOIN agent_backend.file_version v ON v.id=a.version_id JOIN agent_backend.file f ON f.id=v.file_id
 WHERE a.run_id=p_run
$$;

CREATE FUNCTION agent_backend.attachment_manifest(p_run UUID) RETURNS JSONB
LANGUAGE sql STABLE SET search_path=pg_catalog,deanery AS $$
 SELECT jsonb_build_object('protocol','deanery.attachments.v1','run_id',p_run,'files',COALESCE(jsonb_agg(
  jsonb_build_object('file_id',v.file_id,'version_id',v.id,'filename',v.original_name,'extraction_state',v.extraction_state,
   'context_state',a.context_state,'read_mode',a.context_mode,'delivery_state',a.manifest->>'delivery_state',
   'provided_chunk_ids',a.manifest->'provided_chunk_ids','read_chunk_ids',a.manifest->'read_chunk_ids',
   'cited_chunk_ids',a.manifest->'cited_chunk_ids','provided_vision_pages','[]'::JSONB,
   'provided_pages',COALESCE((SELECT jsonb_agg(DISTINCT c->'page') FROM jsonb_array_elements(a.manifest->'chunks') c
        WHERE c->>'page' IS NOT NULL AND a.manifest->'provided_chunk_ids' ? (c->>'chunk_id')),'[]'::JSONB),
   'cited_pages',COALESCE((SELECT jsonb_agg(DISTINCT c->'page') FROM jsonb_array_elements(a.manifest->'chunks') c
        WHERE c->>'page' IS NOT NULL AND a.manifest->'cited_chunk_ids' ? (c->>'chunk_id')),'[]'::JSONB),
   'extraction_coverage',COALESCE(v.extraction->'coverage','{}'::JSONB),'coverage',jsonb_build_object(
       'total_pages',v.extraction->'total_pages','provided_chunks',jsonb_array_length(a.manifest->'provided_chunk_ids'),
       'truncated',COALESCE((v.extraction->>'total_chunks')::INT,0)>jsonb_array_length(a.manifest->'provided_chunk_ids')),
   'limits',COALESCE(a.manifest->'limits','{}'::JSONB),
   'warnings',COALESCE(v.extraction->'warnings','[]'::JSONB)||COALESCE(a.manifest->'warnings','[]'::JSONB)||
        CASE WHEN COALESCE((v.extraction->>'total_chunks')::INT,0)>jsonb_array_length(a.manifest->'provided_chunk_ids')
             THEN '["context_truncated"]'::JSONB ELSE '[]'::JSONB END) ORDER BY v.id),'[]'::JSONB))
 FROM agent_backend.run_attachment a JOIN agent_backend.file_version v ON v.id=a.version_id WHERE a.run_id=p_run
$$;

CREATE FUNCTION backend_api.run_attachment_context(p_run UUID,p_token TEXT) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE v_user INT:=agent_backend.proposal_actor(p_token); r agent_backend.agent_run;
BEGIN
 SELECT * INTO r FROM agent_backend.agent_run WHERE id=p_run AND initiator_user_id=v_user AND session_id IS NOT NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'Run missing' USING ERRCODE='P8001'; END IF;
 IF r.scope_signature IS DISTINCT FROM agent_backend.scope_signature(v_user) OR NOT agent_backend.run_files_visible(r.id,v_user)
    THEN RAISE EXCEPTION 'Scope changed' USING ERRCODE='P8008'; END IF;
 RETURN agent_backend.attachment_manifest(p_run);
END $$;

CREATE FUNCTION backend_api.run_attachment_descriptor(p_run UUID,p_worker UUID,p_version UUID) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE r agent_backend.agent_run;
BEGIN
 r:=agent_backend.read_agent_run(p_run,p_worker);
 IF NOT EXISTS(SELECT 1 FROM agent_backend.run_attachment WHERE run_id=p_run AND version_id=p_version)
    OR NOT agent_backend.file_version_visible(p_version,r.initiator_user_id) THEN RAISE EXCEPTION 'File missing' USING ERRCODE='P0002'; END IF;
 RETURN agent_backend.file_descriptor(p_version);
END $$;

CREATE FUNCTION backend_api.record_attachment_context(p_run UUID,p_worker UUID,p_action TEXT,p_chunks JSONB,p_limits JSONB DEFAULT '{}') RETURNS VOID
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
 IF (SELECT COALESCE(sum(jsonb_array_length(manifest->'chunks')),0) FROM agent_backend.run_attachment WHERE run_id=p_run)>20
    THEN RAISE EXCEPTION 'Chunk budget exceeded' USING ERRCODE='22023'; END IF;
END $$;

CREATE FUNCTION agent_backend.finalize_attachment_answer(r agent_backend.agent_run,p_answer TEXT) RETURNS JSONB
LANGUAGE plpgsql SET search_path=pg_catalog,deanery AS $$
DECLARE v_answer TEXT:=p_answer; v_match TEXT[]; v_id TEXT; v_chunk JSONB; a agent_backend.run_attachment;
    v_file agent_backend.file_version; v_label TEXT; v_link TEXT; v_bad BOOLEAN:=FALSE;
BEGIN
 IF NOT agent_backend.run_files_visible(r.id,r.initiator_user_id) THEN RAISE EXCEPTION 'Attachment access changed' USING ERRCODE='P8008'; END IF;
 -- Model-authored download URLs are never proof of a source, even for a valid UUID.
 IF v_answer ~ '/(?:api/v1/)?files/[^\s)<>]*/download' THEN
    v_answer:=regexp_replace(v_answer,'(?:https?://[^/\s)<>]+)?/(?:api/v1/)?files/[^\s)<>]*/download[^\s)<>]*','Источник не подтверждён','g'); v_bad:=TRUE;
 END IF;
 FOR v_match IN SELECT regexp_matches(v_answer,'\[\[attachment:([^]\r\n]+)\]\]','g') LOOP
  v_id:=v_match[1]; v_chunk:=NULL;
  SELECT ra.* INTO a FROM agent_backend.run_attachment ra WHERE ra.run_id=r.id AND ra.manifest->'acknowledged_chunk_ids' ? v_id;
  IF FOUND THEN
   SELECT c INTO v_chunk FROM jsonb_array_elements(a.manifest->'chunks') c WHERE c->>'chunk_id'=v_id;
   SELECT * INTO v_file FROM agent_backend.file_version WHERE id=a.version_id;
  END IF;
  IF v_chunk IS NULL OR NOT agent_backend.file_version_visible(a.version_id,r.initiator_user_id) THEN
    v_link:='Источник не подтверждён'; v_bad:=TRUE;
  ELSE
    v_label:=CASE WHEN v_chunk->>'page' IS NOT NULL THEN 'стр. '||(v_chunk->>'page') ELSE 'фрагмент '||COALESCE(v_chunk->>'block','1')||CASE WHEN v_chunk->>'block_end' IS NOT NULL AND v_chunk->>'block_end' IS DISTINCT FROM v_chunk->>'block' THEN '–'||(v_chunk->>'block_end') ELSE '' END END;
    v_link:='['||v_label||'](/api/v1/files/'||v_file.file_id::TEXT||'/versions/'||a.version_id::TEXT||'/download'||
        CASE WHEN v_file.mime_type='application/pdf' AND v_chunk->>'page' IS NOT NULL THEN '#page='||(v_chunk->>'page') ELSE '' END||')';
    UPDATE agent_backend.run_attachment SET manifest=CASE WHEN manifest->'cited_chunk_ids' ? v_id THEN manifest ELSE
       jsonb_set(manifest,'{cited_chunk_ids}',manifest->'cited_chunk_ids'||to_jsonb(v_id)) END WHERE run_id=r.id AND version_id=a.version_id;
  END IF;
  v_answer:=replace(v_answer,'[[attachment:'||v_id||']]',v_link);
 END LOOP;
 UPDATE agent_backend.run_attachment SET context_state=CASE WHEN jsonb_array_length(manifest->'cited_chunk_ids')>0 THEN 'used' ELSE 'not_used' END,
    manifest=CASE WHEN v_bad THEN jsonb_set(manifest,'{warnings}',manifest->'warnings'||'["unverified_citation"]'::JSONB) ELSE manifest END WHERE run_id=r.id;
 RETURN jsonb_build_object('answer',v_answer);
END $$;

-- P10: exact run attachment provenance; no new tables.


CREATE OR REPLACE FUNCTION agent_backend.validate_agent_run(r agent_backend.agent_run,p_worker UUID) RETURNS VOID
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
BEGIN
    IF r.id IS NULL OR r.finished_at IS NOT NULL OR r.status<>'running' OR r.lease_owner IS DISTINCT FROM p_worker
       OR p_worker IS NULL OR r.lease_until IS NULL OR r.lease_until<=clock_timestamp() THEN RAISE EXCEPTION 'Lease lost' USING ERRCODE='P8009'; END IF;
    IF r.stop_requested_at IS NOT NULL THEN RAISE EXCEPTION 'Run stopped' USING ERRCODE='P8007'; END IF;
    IF NOT EXISTS(SELECT 1 FROM agent_backend.auth_session s JOIN deanery.app_user u ON u.user_id=s.user_id
        WHERE s.id=r.auth_session_id AND s.user_id=r.initiator_user_id AND s.revoked_at IS NULL
          AND s.expires_at>clock_timestamp() AND u.is_active) THEN RAISE EXCEPTION 'Authorization revoked' USING ERRCODE='42501'; END IF;
    IF NOT agent_backend.run_files_visible(r.id,r.initiator_user_id) THEN RAISE EXCEPTION 'Attachment access changed' USING ERRCODE='P8008'; END IF;
    IF r.scope_signature IS DISTINCT FROM agent_backend.scope_signature(r.initiator_user_id) THEN
        RAISE EXCEPTION 'Scope changed' USING ERRCODE='P8008'; END IF;
END $$;

CREATE OR REPLACE FUNCTION backend_api.list_chats(p_token TEXT,p_limit INT,p_offset INT) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE v_user INT:=agent_backend.proposal_actor(p_token); v_scope TEXT:=agent_backend.scope_signature(v_user); v_result JSONB;
BEGIN
    IF p_limit IS NULL OR p_offset IS NULL OR p_limit NOT BETWEEN 1 AND 500 OR p_offset<0 THEN
        RAISE EXCEPTION 'Invalid page' USING ERRCODE='22023'; END IF;
    SELECT jsonb_build_object('items',COALESCE(jsonb_agg(x.item ORDER BY x.updated_at DESC,x.id),'[]'::JSONB),
        'limit',p_limit,'offset',p_offset,'has_more',(SELECT count(*) FROM agent_backend.chat_session WHERE user_id=v_user)>p_offset::BIGINT+p_limit)
    INTO v_result FROM (SELECT s.id,s.updated_at,jsonb_build_object('id',s.id,'title',s.title,'updatedAt',s.updated_at,
        'preview',COALESCE((SELECT CASE WHEN agent_backend.message_files_visible(m.metadata,v_scope,v_user) THEN left(m.text,120) ELSE '' END
            FROM agent_backend.chat_message m WHERE m.session_id=s.id AND m.role<>'error' ORDER BY m.sequence DESC LIMIT 1),'')) AS item
        FROM agent_backend.chat_session s WHERE s.user_id=v_user ORDER BY s.updated_at DESC,s.id LIMIT p_limit OFFSET p_offset) x;
    RETURN v_result;
END $$;

CREATE OR REPLACE FUNCTION backend_api.chat_messages(p_id UUID,p_token TEXT,p_limit INT,p_offset INT) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE v_user INT:=agent_backend.proposal_actor(p_token); v_scope TEXT:=agent_backend.scope_signature(v_user); v_result JSONB;
BEGIN
    PERFORM backend_api.get_chat(p_id,p_token);
    IF p_limit IS NULL OR p_offset IS NULL OR p_limit NOT BETWEEN 1 AND 500 OR p_offset<0 THEN RAISE EXCEPTION 'Invalid page' USING ERRCODE='22023'; END IF;
    SELECT jsonb_build_object('items',COALESCE(jsonb_agg(x.item ORDER BY x.sequence),'[]'::JSONB),'limit',p_limit,'offset',p_offset,
        'has_more',(SELECT count(*) FROM agent_backend.chat_message WHERE session_id=p_id)>p_offset::BIGINT+p_limit) INTO v_result
    FROM (SELECT m.sequence,jsonb_build_object('id',m.id,'role',m.role,'at',m.created_at,
        'text',CASE WHEN agent_backend.message_files_visible(m.metadata,v_scope,v_user) THEN m.text ELSE 'Сообщение скрыто: изменились права доступа' END,
        'runId',m.metadata->'run_id','attachments',CASE WHEN agent_backend.message_files_visible(m.metadata,v_scope,v_user) THEN agent_backend.run_file_metadata(r.id) ELSE '[]'::JSONB END,'attachment_context',CASE WHEN agent_backend.message_files_visible(m.metadata,v_scope,v_user) THEN agent_backend.attachment_manifest(r.id) ELSE NULL END,'proposals',CASE WHEN m.role IN ('agent','error') AND agent_backend.message_files_visible(m.metadata,v_scope,v_user)
            THEN agent_backend.run_proposals((m.metadata->>'run_id')::UUID) ELSE '[]'::JSONB END,
        'tools',CASE WHEN agent_backend.message_files_visible(m.metadata,v_scope,v_user) THEN COALESCE(r.tools_used,'[]'::JSONB) ELSE '[]'::JSONB END,
        'decisions',CASE WHEN agent_backend.message_files_visible(m.metadata,v_scope,v_user) THEN COALESCE((SELECT jsonb_object_agg(p.id,p.status)
             FROM agent_backend.proposal p WHERE p.run_id=r.id AND p.status<>'pending'),'{}'::JSONB) ELSE '{}'::JSONB END) AS item
        FROM agent_backend.chat_message m LEFT JOIN agent_backend.agent_run r ON r.id=(m.metadata->>'run_id')::UUID
        WHERE m.session_id=p_id ORDER BY m.sequence LIMIT p_limit OFFSET p_offset) x;
    RETURN v_result;
END $$;

CREATE OR REPLACE FUNCTION backend_api.start_agent_run(p_session UUID,p_message TEXT,p_attachments JSONB,p_key UUID,p_token TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE v_user INT:=agent_backend.proposal_actor(p_token); v_auth UUID; v_scope TEXT; v_title TEXT; v_request INT;
    saved agent_backend.idempotency_record; v_hash BYTEA; s agent_backend.chat_session; r agent_backend.agent_run; v_sequence BIGINT; v_ref JSONB; v_descriptor JSONB; v_total BIGINT:=0; v_history JSONB;
BEGIN
    IF p_message IS NULL OR length(btrim(p_message))=0 OR length(p_message)>16000 OR p_key IS NULL
       OR jsonb_typeof(p_attachments) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid message' USING ERRCODE='22023'; END IF;
    IF jsonb_array_length(p_attachments)>5 THEN RAISE EXCEPTION 'Too many attachments' USING ERRCODE='22023'; END IF;
    IF (SELECT count(DISTINCT x->>'version_id') FROM jsonb_array_elements(p_attachments) x)<>jsonb_array_length(p_attachments)
        THEN RAISE EXCEPTION 'Duplicate attachment' USING ERRCODE='22023'; END IF;
    FOR v_ref IN SELECT * FROM jsonb_array_elements(p_attachments) LOOP
        IF jsonb_typeof(v_ref)<>'object' OR NOT v_ref ?& ARRAY['file_id','version_id'] OR v_ref-ARRAY['file_id','version_id']<>'{}'::JSONB
            THEN RAISE EXCEPTION 'Invalid attachment' USING ERRCODE='22023'; END IF;
        v_descriptor:=agent_backend.file_descriptor((v_ref->>'version_id')::UUID);
        IF v_descriptor IS NULL OR (v_descriptor->>'file_id')::UUID IS DISTINCT FROM (v_ref->>'file_id')::UUID
           OR NOT agent_backend.file_version_visible((v_ref->>'version_id')::UUID,v_user)
            THEN RAISE EXCEPTION 'File missing' USING ERRCODE='P0002'; END IF;
        IF v_descriptor->>'extraction_state' NOT IN ('ready','partial') THEN RAISE EXCEPTION 'File not ready' USING ERRCODE='P8101'; END IF;
        v_total:=v_total+(v_descriptor->>'byte_size')::BIGINT;
    END LOOP;
    IF v_total>20000000 THEN RAISE EXCEPTION 'Attachments too large' USING ERRCODE='P8102'; END IF;
    v_hash:=sha256(convert_to(jsonb_build_array(p_session,p_message,p_attachments)::TEXT,'UTF8'));
    INSERT INTO agent_backend.idempotency_record(user_id,route,key,request_hash)
        VALUES(v_user,'/agent/chat/stream',p_key,v_hash) ON CONFLICT DO NOTHING;
    SELECT * INTO saved FROM agent_backend.idempotency_record WHERE user_id=v_user AND route='/agent/chat/stream' AND key=p_key FOR UPDATE;
    IF saved.request_hash<>v_hash THEN RAISE EXCEPTION 'Key conflict' USING ERRCODE='P6001'; END IF;
    IF saved.response_removed_at IS NOT NULL THEN RAISE EXCEPTION 'Chat deleted' USING ERRCODE='P8001'; END IF;
    IF saved.run_id IS NOT NULL THEN
        SELECT * INTO r FROM agent_backend.agent_run WHERE id=saved.run_id;
        IF r.session_id IS NULL THEN RAISE EXCEPTION 'Chat deleted' USING ERRCODE='P8001'; END IF;
        IF NOT agent_backend.run_files_visible(r.id,v_user) OR r.scope_signature IS DISTINCT FROM agent_backend.scope_signature(v_user) THEN RAISE EXCEPTION 'Scope changed' USING ERRCODE='P8008'; END IF;
        RETURN jsonb_build_object('run_id',r.id,'session_id',r.session_id);
    END IF;
    IF p_session IS NULL THEN
        v_title:=btrim(regexp_replace(p_message,'\s+',' ','g'));
        IF length(v_title)>60 THEN v_title:=left(v_title,59)||'…'; END IF;
        INSERT INTO agent_backend.chat_session(user_id,title) VALUES(v_user,v_title) RETURNING * INTO s;
    ELSE
        SELECT * INTO s FROM agent_backend.chat_session WHERE id=p_session AND user_id=v_user FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'Chat missing' USING ERRCODE='P8001'; END IF;
    END IF;
    IF EXISTS(SELECT 1 FROM agent_backend.agent_run WHERE session_id=s.id AND finished_at IS NULL) THEN
        RAISE EXCEPTION 'Chat busy' USING ERRCODE='P8002'; END IF;
    SELECT session_id INTO v_auth FROM agent_backend.auth_token WHERE token_hash=sha256(convert_to(p_token,'UTF8'));
    v_scope:=agent_backend.scope_signature(v_user);
    INSERT INTO deanery.agent_request(user_id,request_text) VALUES(v_user,p_message) RETURNING agent_request_id INTO v_request;
    INSERT INTO agent_backend.agent_run(session_id,initiator_user_id,agent_request_id,status,auth_session_id,scope_signature)
        VALUES(s.id,v_user,v_request,'queued',v_auth,v_scope) RETURNING * INTO r;
    INSERT INTO agent_backend.run_attachment(run_id,version_id,manifest)
        SELECT r.id,(x->>'version_id')::UUID,jsonb_build_object('delivery_state','pending','provided_chunk_ids','[]'::JSONB,
            'acknowledged_chunk_ids','[]'::JSONB,'read_chunk_ids','[]'::JSONB,'cited_chunk_ids','[]'::JSONB,'chunks','[]'::JSONB,'warnings','[]'::JSONB)
        FROM jsonb_array_elements(p_attachments) x;
    SELECT COALESCE(jsonb_agg(DISTINCT x.run_id),'[]'::JSONB) INTO v_history FROM
        (SELECT m.metadata->>'run_id' AS run_id FROM agent_backend.chat_message m WHERE m.session_id=s.id
         AND m.role IN ('user','agent') AND agent_backend.message_files_visible(m.metadata,v_scope,v_user)
         ORDER BY m.sequence DESC LIMIT 20) x;
    UPDATE agent_backend.agent_run SET events=jsonb_build_array(jsonb_build_object('sequence',1,'event','session',
        'data',jsonb_build_object('session_id',s.id,'run_id',r.id))) WHERE id=r.id;
    SELECT COALESCE(max(sequence),0)+1 INTO v_sequence FROM agent_backend.chat_message WHERE session_id=s.id;
    INSERT INTO agent_backend.chat_message(session_id,sequence,role,text,metadata) VALUES(s.id,v_sequence,'user',p_message,
        jsonb_build_object('run_id',r.id,'scope_signature',v_scope,'context_run_ids',v_history));
    UPDATE agent_backend.chat_session SET updated_at=clock_timestamp() WHERE id=s.id;
    UPDATE agent_backend.idempotency_record SET run_id=r.id,session_id=s.id,response_status=200,
        response_body=jsonb_build_object('run_id',r.id,'session_id',s.id)
        WHERE user_id=v_user AND route='/agent/chat/stream' AND key=p_key;
    RETURN jsonb_build_object('run_id',r.id,'session_id',s.id);
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

CREATE OR REPLACE FUNCTION agent_backend.agent_context(r agent_backend.agent_run) RETURNS JSONB
LANGUAGE sql STABLE SET search_path=pg_catalog,deanery AS $$
    SELECT jsonb_build_object('run_id',r.id,'session_id',r.session_id,'initiator_user_id',r.initiator_user_id,
        'attachments',COALESCE((SELECT jsonb_agg(agent_backend.file_descriptor(a.version_id) ORDER BY a.version_id) FROM agent_backend.run_attachment a WHERE a.run_id=r.id),'[]'::JSONB),'agent_request_id',r.agent_request_id,'actor',(SELECT to_jsonb(a) FROM backend_api.account_snapshot(r.initiator_user_id) a),
        'message',(SELECT request_text FROM deanery.agent_request WHERE agent_request_id=r.agent_request_id),
        'history',COALESCE((SELECT jsonb_agg(jsonb_build_object('role',x.role,'text',x.text) ORDER BY x.sequence)
            FROM (SELECT m.role,m.text,m.sequence FROM agent_backend.chat_message m WHERE m.session_id=r.session_id
                AND m.role IN ('user','agent') AND m.metadata->>'run_id'<>r.id::TEXT
                AND agent_backend.message_files_visible(m.metadata,r.scope_signature,r.initiator_user_id)
                AND (SELECT metadata->'context_run_ids' FROM agent_backend.chat_message WHERE session_id=r.session_id AND metadata->>'run_id'=r.id::TEXT AND role='user') ? (m.metadata->>'run_id') ORDER BY m.sequence DESC LIMIT 20) x),'[]'::JSONB))
$$;

CREATE OR REPLACE FUNCTION backend_api.read_agent_events(p_run UUID,p_token TEXT,p_after BIGINT) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE v_user INT:=agent_backend.proposal_actor(p_token); r agent_backend.agent_run;
BEGIN
    IF p_after IS NULL OR p_after<0 THEN RAISE EXCEPTION 'Invalid event cursor' USING ERRCODE='22023'; END IF;
    SELECT * INTO r FROM agent_backend.agent_run WHERE id=p_run AND initiator_user_id=v_user AND session_id IS NOT NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'Run missing' USING ERRCODE='P8001'; END IF;
    IF NOT agent_backend.run_files_visible(r.id,v_user) THEN RAISE EXCEPTION 'Attachment access changed' USING ERRCODE='P8008'; END IF;
    IF r.scope_signature IS DISTINCT FROM agent_backend.scope_signature(v_user) THEN RAISE EXCEPTION 'Scope changed' USING ERRCODE='P8008'; END IF;
    IF p_after>jsonb_array_length(r.events) THEN RAISE EXCEPTION 'Invalid event cursor' USING ERRCODE='22023'; END IF;
    RETURN jsonb_build_object('events',COALESCE((SELECT jsonb_agg(e ORDER BY (e->>'sequence')::BIGINT)
        FROM jsonb_array_elements(r.events) e WHERE (e->>'sequence')::BIGINT>p_after),'[]'::JSONB),
        'finished',r.finished_at IS NOT NULL,'status',r.status);
END $$;

CREATE FUNCTION agent_backend.proposal_context_files(p agent_backend.proposal,p_user INT) RETURNS JSONB
LANGUAGE sql STABLE SET search_path=pg_catalog,deanery AS $$
 SELECT CASE WHEN NOT agent_backend.proposal_file_access(p,p_user) THEN '[]'::JSONB ELSE
  COALESCE((SELECT jsonb_agg(jsonb_build_object('file_id',v.file_id,'version_id',v.id,'filename',v.original_name,
    'title',f.name,'mime',v.mime_type,'size',v.byte_size,'chunks',c.chunks,'download_url',
    '/api/v1/files/'||v.file_id::TEXT||'/versions/'||v.id::TEXT||'/download') ORDER BY v.id)
   FROM (SELECT (chunk->>'version_id')::UUID AS version_id,jsonb_agg(chunk ORDER BY chunk->>'chunk_id') chunks
    FROM agent_backend.proposal_event e CROSS JOIN LATERAL jsonb_array_elements(e.data->'chunks') chunk
    WHERE e.proposal_id=p.id AND e.event_type='attachment_context' GROUP BY chunk->>'version_id') c
   JOIN agent_backend.file_version v ON v.id=c.version_id JOIN agent_backend.file f ON f.id=v.file_id
   WHERE agent_backend.file_version_visible(v.id,p_user)),'[]'::JSONB) END
$$;

DROP FUNCTION backend_api.prepare_run_proposal(UUID,UUID,JSONB,TEXT,TEXT,UUID,UUID);
CREATE FUNCTION backend_api.prepare_run_proposal(p_run UUID,p_worker UUID,p_command JSONB,p_explanation TEXT,p_reason TEXT,
 p_key UUID,p_supersedes UUID DEFAULT NULL,p_attachment_chunk_ids JSONB DEFAULT '[]') RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE r agent_backend.agent_run; v_ids JSONB; v_chunks JSONB; v_result JSONB; v_saved JSONB; v_existing BOOLEAN; p agent_backend.proposal;
BEGIN
 r:=agent_backend.lock_agent_run(p_run,p_worker);
 IF jsonb_typeof(p_attachment_chunk_ids) IS DISTINCT FROM 'array' OR jsonb_array_length(p_attachment_chunk_ids)>20
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_attachment_chunk_ids) x WHERE jsonb_typeof(x)<>'string')
  THEN RAISE EXCEPTION 'Invalid evidence selection' USING ERRCODE='22023'; END IF;
 SELECT COALESCE(jsonb_agg(DISTINCT x ORDER BY x),'[]'::JSONB) INTO v_ids FROM jsonb_array_elements(p_attachment_chunk_ids) x;
 IF jsonb_array_length(v_ids)<>jsonb_array_length(p_attachment_chunk_ids) THEN RAISE EXCEPTION 'Duplicate evidence' USING ERRCODE='22023'; END IF;
 SELECT COALESCE(jsonb_agg(c ORDER BY c->>'chunk_id'),'[]'::JSONB) INTO v_chunks
  FROM agent_backend.run_attachment a CROSS JOIN LATERAL jsonb_array_elements(a.manifest->'chunks') c
  WHERE a.run_id=p_run AND v_ids ? (c->>'chunk_id') AND a.manifest->'acknowledged_chunk_ids' ? (c->>'chunk_id')
   AND agent_backend.file_version_visible(a.version_id,r.initiator_user_id);
 IF jsonb_array_length(v_chunks)<>jsonb_array_length(v_ids) THEN RAISE EXCEPTION 'Evidence not delivered' USING ERRCODE='22023'; END IF;
 SELECT EXISTS(SELECT 1 FROM agent_backend.idempotency_record WHERE user_id=r.initiator_user_id
  AND route='/proposal/prepare/'||p_run::TEXT AND key=p_key AND response_body IS NOT NULL) INTO v_existing;
 v_result:=agent_backend.prepare_proposal_as(p_run,p_command,p_explanation,p_reason,p_key,r.initiator_user_id,p_supersedes);
 SELECT * INTO p FROM agent_backend.proposal WHERE id=(v_result->>'id')::UUID;
 SELECT data->'chunks' INTO v_saved FROM agent_backend.proposal_event WHERE proposal_id=p.id AND event_type='attachment_context';
 IF FOUND THEN
   IF v_saved IS DISTINCT FROM v_chunks THEN RAISE EXCEPTION 'Evidence idempotency conflict' USING ERRCODE='P6001'; END IF;
 ELSE
   IF v_existing AND v_chunks<>'[]'::JSONB THEN RAISE EXCEPTION 'Evidence idempotency conflict' USING ERRCODE='P6001'; END IF;
   INSERT INTO agent_backend.proposal_event(proposal_id,actor_user_id,event_type,data)
      VALUES(p.id,r.initiator_user_id,'attachment_context',jsonb_build_object('chunks',v_chunks));
 END IF;
 RETURN agent_backend.proposal_view(p,r.initiator_user_id);
END $$;

CREATE OR REPLACE FUNCTION agent_backend.proposal_view(p agent_backend.proposal,p_user INT) RETURNS JSONB
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,deanery AS $$
DECLARE v_valid TEXT; v_eligible BOOLEAN; v_decide BOOLEAN; v_author TEXT; v_assignee TEXT; v_decider TEXT;
BEGIN
    v_valid:=agent_backend.proposal_validity(p);
    v_eligible:=agent_backend.proposal_eligible(p,p_user);
    v_decide:=p.status='pending' AND p.assignee_user_id=p_user AND v_eligible;
    SELECT COALESCE(concat_ws(' ',n.last_name,n.first_name,n.middle_name),u.login) INTO v_author
        FROM deanery.app_user u LEFT JOIN deanery.person n ON n.person_id=u.person_id WHERE u.user_id=p.initiator_user_id;
    SELECT COALESCE(concat_ws(' ',n.last_name,n.first_name,n.middle_name),u.login) INTO v_assignee
        FROM deanery.app_user u LEFT JOIN deanery.person n ON n.person_id=u.person_id WHERE u.user_id=p.assignee_user_id;
    SELECT u.login INTO v_decider FROM deanery.app_user u WHERE u.user_id=p.decided_by;
    RETURN jsonb_build_object('id',p.id,'kind',p.kind,'submission_status',p.submission_status,'correction_id',p.correction_id,'status',p.status,'version',p.version,'explanation',p.explanation,
        'reason',p.reason,'sql_text','','created_at',p.created_at,'expires_at',p.expires_at,
        'initiator',jsonb_build_object('user_id',p.initiator_user_id,'full_name',v_author),
        'decided_by',v_decider,'decided_at',p.decided_at,'decision_reason',p.decision_reason,
        'validity',jsonb_build_object('state',v_valid,'reason',CASE WHEN v_valid='current' THEN NULL ELSE v_valid END),
        'routing',jsonb_build_object('institute_id',p.institute_id,'assignee_user_id',p.assignee_user_id,'assignee_name',v_assignee),
        'execution',jsonb_build_object('effective_date',p.effective_date,'order_id',NULL,'job_id',NULL,
             'started_at',NULL,'completed_at',NULL,'error',NULL) || p.execution,
        'actions',jsonb_build_object('can_claim',p.status='pending' AND p.assignee_user_id IS NULL AND v_eligible,
             'can_assign',agent_backend.proposal_can_assign(p,p_user),
             'can_submit',COALESCE(p.kind='grade_correction' AND p.submission_status='draft' AND p.initiator_user_id=p_user
                AND p.status='pending' AND v_valid='current' AND backend_api.command_authorized(p.command,p_user,'prepare'),FALSE),
             'can_approve',COALESCE(v_decide AND v_valid='current'
                AND (p.submission_status='submitted' OR backend_api.command_authorized(p.command,p.initiator_user_id,'prepare'))
                AND backend_api.command_authorized(p.command,p_user,'execute'),FALSE),
             'can_reject',COALESCE(v_decide,FALSE)),
        'preview',p.preview || jsonb_build_object('applied',p.execution->'applied'), 'context_files',agent_backend.proposal_context_files(p,p_user));
END $$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA agent_backend FROM PUBLIC;
REVOKE ALL ON FUNCTION backend_api.run_attachment_context(UUID,TEXT),backend_api.run_attachment_descriptor(UUID,UUID,UUID),
 backend_api.record_attachment_context(UUID,UUID,TEXT,JSONB,JSONB),backend_api.prepare_run_proposal(UUID,UUID,JSONB,TEXT,TEXT,UUID,UUID,JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION backend_api.run_attachment_context(UUID,TEXT) TO backend_api;
GRANT EXECUTE ON FUNCTION backend_api.run_attachment_descriptor(UUID,UUID,UUID),backend_api.record_attachment_context(UUID,UUID,TEXT,JSONB,JSONB),
 backend_api.prepare_run_proposal(UUID,UUID,JSONB,TEXT,TEXT,UUID,UUID,JSONB) TO backend_executor;

CREATE OR REPLACE FUNCTION backend_api.finish_agent_run(p_run UUID,p_worker UUID,p_answer TEXT,p_error TEXT DEFAULT NULL) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE r agent_backend.agent_run; v_error TEXT:=p_error;
BEGIN
    SELECT * INTO r FROM agent_backend.agent_run WHERE id=p_run FOR UPDATE;
    IF NOT FOUND OR p_worker IS NULL OR r.lease_owner IS DISTINCT FROM p_worker OR r.session_id IS NULL THEN
        RAISE EXCEPTION 'Lease lost' USING ERRCODE='P8009'; END IF;
    IF r.finished_at IS NOT NULL THEN RETURN r.result; END IF;
    IF v_error IS NOT NULL AND v_error NOT IN ('agent_error','agent_unavailable','agent_protocol_error','agent_outcome_unknown',
        'agent_cancelled','agent_scope_changed','forbidden','agent_context_limit','agent_context_uncalibrated') THEN v_error:='agent_error'; END IF;
    IF length(p_answer)>64000 THEN v_error:='agent_protocol_error'; END IF;
    BEGIN
        PERFORM agent_backend.validate_agent_run(r,p_worker);
    EXCEPTION WHEN SQLSTATE 'P8009' THEN v_error:='agent_outcome_unknown';
        WHEN SQLSTATE 'P8007' THEN v_error:='agent_cancelled';
        WHEN SQLSTATE 'P8008' THEN v_error:='agent_scope_changed';
        WHEN SQLSTATE '42501' THEN v_error:='forbidden';
    END;
    RETURN agent_backend.end_agent_run(p_run,p_answer,v_error);
END $$;
