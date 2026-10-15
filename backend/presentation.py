"""Keep additive batch previews readable by clients using the single-record contract."""
from fastapi.responses import JSONResponse


def preview_contract(value):
    if isinstance(value,list):
        return [preview_contract(item) for item in value]
    if not isinstance(value,dict):
        return value
    result=value.copy()
    preview=value.get('preview')
    if isinstance(preview,dict) and preview.get('operation')=='BATCH':
        before,after={},{}
        for item in preview.get('items',[]):
            for field in item.get('changed_columns',[]):
                label=f"Строка {item['item_id']} · {field}"
                before[label]=(item.get('before') or {}).get(field)
                after[label]=(item.get('after') or {}).get(field)
        result['preview']=preview | {'table':'Пакет изменений','before':before,'after':after,
            'changed_columns':list(after),'snapshot_hash':preview.get('snapshot_hash'),'note':preview.get('note')}
    for key in ('items','proposals','events','data','result'):
        if key in value:
            result[key]=preview_contract(value[key])
    return result


class ApiJSONResponse(JSONResponse):
    def render(self,content):
        return super().render(preview_contract(content))
