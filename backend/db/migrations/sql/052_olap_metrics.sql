-- Метрики экрана OLAP: признак «обучается» у студента, форма контроля и результат словами у итогового результата.
-- Меняется только backend_api.olap_dataset; область видимости и проверка роли прежние.
DO $fix$ DECLARE definition TEXT; student_needle TEXT; result_needle TEXT; BEGIN
    SELECT pg_get_functiondef('backend_api.olap_dataset(text)'::regprocedure) INTO definition;
    student_needle:='SELECT s.student_id,fn_full_name(p) AS student,s.group_id,g.name AS group_name,s.status_id,';
    result_needle:='ct.is_graded,fn_mark(lr.points) AS mark,gs.sheet_kind';
    IF position(student_needle IN definition)=0 OR position(result_needle IN definition)=0 THEN
        RAISE EXCEPTION 'OLAP dataset changed; operator review required'; END IF;
    definition:=replace(definition,student_needle,student_needle||
        '(SELECT st.is_active FROM student_status st WHERE st.status_id=s.status_id) AS is_active,');
    definition:=replace(definition,result_needle,result_needle||
        ',ct.name AS control_type,fn_result_name(lr.points,lr.is_absent,ct.is_graded,TRUE) AS result');
    EXECUTE definition;
END $fix$;
