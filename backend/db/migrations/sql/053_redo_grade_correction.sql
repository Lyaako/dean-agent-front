-- «Подготовить заново» у отклонённой заявки на исправление оценки, в том числе поданной через форму.
-- Повтор — новая заявка по той же оценке; ux_one_open_correction не даст подать её, пока есть pending/approved.
CREATE FUNCTION agent_backend.correction_redo(p agent_backend.proposal,p_user INT) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
    SELECT COALESCE(p.initiator_user_id=p_user AND p.status='rejected' AND NOT EXISTS(
        SELECT FROM grade_correction other JOIN grade_correction mine ON mine.grade_id=other.grade_id
        WHERE mine.correction_id=p.correction_id AND other.status IN ('pending','approved'))
        AND p.correction_id IS NOT NULL,FALSE)
$$;

ALTER FUNCTION agent_backend.proposal_view(agent_backend.proposal,INT) RENAME TO proposal_view_v3;
CREATE FUNCTION agent_backend.proposal_view(p agent_backend.proposal,p_user INT) RETURNS JSONB
LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE result JSONB:=agent_backend.proposal_view_v3(p,p_user);
BEGIN
    -- У исправлений оценки срока нет, а текст просьбы не нужен: правило своё, для формы и агента одинаковое.
    IF p.kind='grade_correction' THEN
        result:=jsonb_set(result,'{actions,can_redo}',to_jsonb(agent_backend.correction_redo(p,p_user)));
    END IF;
    RETURN result;
END $$;

REVOKE ALL ON FUNCTION agent_backend.correction_redo(agent_backend.proposal,INT),
    agent_backend.proposal_view(agent_backend.proposal,INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION agent_backend.correction_redo(agent_backend.proposal,INT),
    agent_backend.proposal_view(agent_backend.proposal,INT) TO backend_api,backend_executor;
