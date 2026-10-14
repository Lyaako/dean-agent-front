-- No new domain rights: these owner readers always validate the supplied access token.
GRANT USAGE ON SCHEMA backend_api TO deanery_read;
GRANT EXECUTE ON FUNCTION backend_api.visible_rows(TEXT,TEXT),backend_api.olap_facts(TEXT,INT,INT,INT,INT) TO deanery_read;
