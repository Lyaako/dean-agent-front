-- API-only views: original deanery definitions remain unchanged.
CREATE VIEW backend_api.v_curriculum AS
SELECT ci.item_id, sp.code || ' ' || sp.name AS specialty, pr.profile, sf.name AS study_form, c.start_year,
       ci.semester, dis.name AS discipline, dis.kind, ct.name AS control_type,
       ci.lecture_hours, ci.practice_hours, ci.lab_hours, ci.self_study_hours,
       ci.lecture_hours + ci.practice_hours + ci.lab_hours + ci.self_study_hours AS total_hours,
       deanery.fn_credits(ci) AS credits
FROM deanery.curriculum_item ci
JOIN deanery.curriculum c ON c.curriculum_id = ci.curriculum_id
JOIN deanery.study_program pr ON pr.program_id = c.program_id
JOIN deanery.specialty sp ON sp.specialty_id = pr.specialty_id
JOIN deanery.study_form sf ON sf.study_form_id = c.study_form_id
JOIN deanery.discipline dis ON dis.discipline_id = ci.discipline_id
JOIN deanery.control_type ct ON ct.control_type_id = ci.control_type_id;

CREATE VIEW backend_api.v_schedule_hours AS
SELECT ta.assignment_id, g.name AS group_name, dis.name AS discipline, lt.name AS lesson_type,
       deanery.fn_full_name(p) AS teacher,
       CASE lt.name WHEN 'Лекция' THEN ci.lecture_hours
                    WHEN 'Практика' THEN ci.practice_hours
                    ELSE ci.lab_hours END AS planned_hours,
       2 * (SELECT COUNT(*) FROM deanery.v_schedule_calendar c
            JOIN deanery.schedule_slot s ON s.slot_id = c.slot_id
            WHERE s.assignment_id = ta.assignment_id) AS scheduled_hours
FROM deanery.teaching_assignment ta
JOIN deanery.study_group g ON g.group_id = ta.group_id
JOIN deanery.curriculum_item ci ON ci.item_id = ta.item_id
JOIN deanery.discipline dis ON dis.discipline_id = ci.discipline_id
JOIN deanery.lesson_type lt ON lt.lesson_type_id = ta.lesson_type_id
JOIN deanery.employee e ON e.employee_id = ta.teacher_id
JOIN deanery.person p ON p.person_id = e.person_id
WHERE EXISTS (SELECT 1 FROM deanery.schedule_slot s WHERE s.assignment_id = ta.assignment_id);

CREATE VIEW backend_api.v_practice AS
SELECT pp.placement_id, deanery.fn_full_name(p) AS student, g.name AS group_name, dis.name AS practice, ci.semester,
       org.name AS organization, deanery.fn_full_name(pt) AS supervisor,
       concat_ws(' ', oc.last_name, oc.first_name, oc.middle_name) || ', ' || oc.job_title AS org_supervisor,
       pp.start_date, pp.end_date, o.order_number
FROM deanery.practice_placement pp
JOIN deanery.curriculum_item ci ON ci.item_id = pp.item_id
JOIN deanery.discipline dis ON dis.discipline_id = ci.discipline_id
JOIN deanery.organization_contact oc ON oc.org_contact_id = pp.org_contact_id
JOIN deanery.organization org ON org.organization_id = oc.organization_id
JOIN deanery.student s ON s.student_id = pp.student_id
JOIN deanery.person p ON p.person_id = s.person_id
JOIN deanery.study_group g ON g.group_id = s.group_id
JOIN deanery.employee et ON et.employee_id = pp.supervisor_id
JOIN deanery.person pt ON pt.person_id = et.person_id
LEFT JOIN deanery.academic_order o ON o.order_id = pp.order_id;

CREATE VIEW backend_api.v_academic_works AS
SELECT aw.work_id, deanery.fn_full_name(p) AS student, g.name AS group_name,
       CASE dis.kind WHEN 'coursework' THEN 'Курсовая работа' ELSE 'ВКР' END AS work_kind,
       dis.name AS discipline, ci.semester, aw.topic,
       deanery.fn_full_name(ps) AS supervisor, deanery.fn_full_name(pr) AS reviewer, o.order_number
FROM deanery.academic_work aw
JOIN deanery.curriculum_item ci ON ci.item_id = aw.item_id
JOIN deanery.discipline dis ON dis.discipline_id = ci.discipline_id
JOIN deanery.student s ON s.student_id = aw.student_id
JOIN deanery.person p ON p.person_id = s.person_id
JOIN deanery.study_group g ON g.group_id = s.group_id
JOIN deanery.employee es ON es.employee_id = aw.supervisor_id
JOIN deanery.person ps ON ps.person_id = es.person_id
LEFT JOIN deanery.employee er ON er.employee_id = aw.reviewer_id
LEFT JOIN deanery.person pr ON pr.person_id = er.person_id
LEFT JOIN deanery.academic_order o ON o.order_id = aw.order_id;

REVOKE ALL ON backend_api.v_curriculum, backend_api.v_schedule_hours,
    backend_api.v_practice, backend_api.v_academic_works FROM PUBLIC;
