-- Historical proposal authorship does not extend borrowed file access.
CREATE OR REPLACE FUNCTION agent_backend.proposal_file_access(p agent_backend.proposal,p_user INT) RETURNS BOOLEAN
LANGUAGE sql STABLE SET search_path=pg_catalog,deanery AS $$
 SELECT COALESCE((agent_backend.proposal_eligible(p,p_user) AND (p.assignee_user_id=p_user OR p.assignee_user_id IS NULL
     OR EXISTS(SELECT 1 FROM backend_api.account_snapshot(p_user) a WHERE a.role_code IN ('admin','director')))),FALSE)
$$;

CREATE OR REPLACE FUNCTION agent_backend.proposal_context_files(p agent_backend.proposal,p_user INT) RETURNS JSONB
LANGUAGE sql STABLE SET search_path=pg_catalog,deanery AS $$
 SELECT CASE WHEN p.initiator_user_id<>p_user AND NOT agent_backend.proposal_file_access(p,p_user) THEN '[]'::JSONB ELSE
  COALESCE((SELECT jsonb_agg(jsonb_build_object('file_id',v.file_id,'version_id',v.id,'filename',v.original_name,
    'title',f.name,'mime',v.mime_type,'size',v.byte_size,'chunks',c.chunks,'download_url',
    '/api/v1/files/'||v.file_id::TEXT||'/versions/'||v.id::TEXT||'/download') ORDER BY v.id)
   FROM (SELECT (chunk->>'version_id')::UUID AS version_id,jsonb_agg(chunk ORDER BY chunk->>'chunk_id') chunks
    FROM agent_backend.proposal_event e CROSS JOIN LATERAL jsonb_array_elements(e.data->'chunks') chunk
    WHERE e.proposal_id=p.id AND e.event_type='attachment_context' GROUP BY chunk->>'version_id') c
   JOIN agent_backend.file_version v ON v.id=c.version_id JOIN agent_backend.file f ON f.id=v.file_id
   WHERE agent_backend.file_version_visible(v.id,p_user)),'[]'::JSONB) END
$$;
