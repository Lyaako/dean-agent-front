-- Зависшие запуски агента: раньше просроченный запуск снимался только в claim_agent_run, то есть когда
-- воркер опрашивает очередь. Без воркера (или после его падения) чат оставался «занят» навсегда.

-- Одно правило в одном месте: запуск без живой аренды или слишком долго ждущий в очереди завершается.
CREATE FUNCTION agent_backend.expire_stale_run(p_run UUID,p_queue_timeout INTERVAL DEFAULT INTERVAL '10 minutes') RETURNS BOOLEAN
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE r agent_backend.agent_run; stale BOOLEAN;
BEGIN
    -- Сначала без блокировки: живая аренда и свежая очередь — частый случай при опросе событий.
    FOR attempt IN 1..2 LOOP
        IF attempt=1 THEN SELECT * INTO r FROM agent_backend.agent_run WHERE id=p_run;
        ELSE SELECT * INTO r FROM agent_backend.agent_run WHERE id=p_run FOR UPDATE; END IF;
        stale:=FOUND AND r.finished_at IS NULL AND r.session_id IS NOT NULL AND (
            (r.status='running' AND (r.lease_until IS NULL OR r.lease_until<=clock_timestamp()))
            OR (r.status='queued' AND r.created_at<=clock_timestamp()-p_queue_timeout));
        IF NOT stale THEN RETURN FALSE; END IF;
    END LOOP;
    PERFORM agent_backend.end_agent_run(r.id,'',CASE r.status WHEN 'queued' THEN 'agent_unavailable' ELSE 'agent_outcome_unknown' END);
    RETURN TRUE;
END $$;

-- Вызов из API перед обращением к запуску или сессии: только свои запуски пользователя.
CREATE FUNCTION backend_api.expire_agent_runs(p_token TEXT,p_session UUID,p_run UUID,p_queue_timeout INTERVAL) RETURNS INT
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,deanery AS $$
DECLARE v_user INT:=agent_backend.proposal_actor(p_token); v_run UUID; expired INT:=0;
BEGIN
    IF p_queue_timeout IS NULL OR p_queue_timeout<INTERVAL '0' THEN RAISE EXCEPTION 'Invalid queue timeout' USING ERRCODE='22023'; END IF;
    FOR v_run IN SELECT id FROM agent_backend.agent_run WHERE finished_at IS NULL AND initiator_user_id=v_user
        AND ((p_session IS NOT NULL AND session_id=p_session) OR (p_run IS NOT NULL AND id=p_run)) ORDER BY created_at,id LOOP
        IF agent_backend.expire_stale_run(v_run,p_queue_timeout) THEN expired:=expired+1; END IF;
    END LOOP;
    RETURN expired;
END $$;

-- claim_agent_run снимает просроченные той же функцией; запуск без аренды тоже считается просроченным.
DO $fix$ DECLARE definition TEXT; loop_needle TEXT; end_needle TEXT; BEGIN
    SELECT pg_get_functiondef('backend_api.claim_agent_run(uuid)'::regprocedure) INTO definition;
    loop_needle:=$n$WHERE status='running' AND finished_at IS NULL AND lease_until<=clock_timestamp()$n$;
    end_needle:=$n$        PERFORM agent_backend.end_agent_run(r.id,'','agent_outcome_unknown');$n$;
    IF position(loop_needle IN definition)=0 OR position(end_needle IN definition)=0 THEN
        RAISE EXCEPTION 'Agent claim changed; operator review required'; END IF;
    definition:=replace(definition,loop_needle,$n$WHERE status='running' AND finished_at IS NULL AND (lease_until IS NULL OR lease_until<=clock_timestamp())$n$);
    EXECUTE replace(definition,end_needle,$n$        PERFORM agent_backend.expire_stale_run(r.id);$n$);
END $fix$;

-- «Остановить» сразу завершает запуск, у которого аренда истекла или её нет: остановить его некому.
DO $fix$ DECLARE definition TEXT; needle TEXT; BEGIN
    SELECT pg_get_functiondef('backend_api.cancel_agent_run(uuid,text)'::regprocedure) INTO definition;
    needle:=$n$IF r.status='queued' THEN PERFORM agent_backend.end_agent_run(r.id,'','agent_cancelled'); END IF;$n$;
    IF position(needle IN definition)=0 THEN RAISE EXCEPTION 'Agent cancel changed; operator review required'; END IF;
    EXECUTE replace(definition,needle,$n$IF r.status='queued' OR r.lease_until IS NULL OR r.lease_until<=clock_timestamp() THEN
        PERFORM agent_backend.end_agent_run(r.id,'','agent_cancelled'); END IF;$n$);
END $fix$;

-- Текст для agent_unavailable подходит и к недоступной модели, и к запуску, который некому разобрать.
DO $fix$ DECLARE definition TEXT; needle TEXT; BEGIN
    SELECT pg_get_functiondef('agent_backend.end_agent_run(uuid,text,text)'::regprocedure) INTO definition;
    needle:=$n$WHEN 'agent_unavailable' THEN 'Модель временно недоступна.'$n$;
    IF position(needle IN definition)=0 THEN RAISE EXCEPTION 'Agent run messages changed; operator review required'; END IF;
    EXECUTE replace(definition,needle,$n$WHEN 'agent_unavailable' THEN 'Агент сейчас недоступен. Отправьте запрос позже.'$n$);
END $fix$;

REVOKE ALL ON FUNCTION agent_backend.expire_stale_run(UUID,INTERVAL),backend_api.expire_agent_runs(TEXT,UUID,UUID,INTERVAL) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION backend_api.expire_agent_runs(TEXT,UUID,UUID,INTERVAL) TO backend_api;
