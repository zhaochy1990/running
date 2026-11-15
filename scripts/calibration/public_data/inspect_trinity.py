"""Extract public GXT running stage means; do not invent secondwise measurements."""
import argparse,collections,csv,hashlib,json,pathlib,re,xml.etree.ElementTree as ET,zipfile
parser=argparse.ArgumentParser(description='Extract local research workbook; never redistribute raw data')
parser.add_argument('--directory',required=True,type=pathlib.Path,help='local research directory outside Git')
P=parser.parse_args().directory.resolve();N={'m':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
def sheets(path):
    z=zipfile.ZipFile(path); ss=[]
    if 'xl/sharedStrings.xml' in z.namelist(): ss=[''.join(x.itertext()) for x in ET.fromstring(z.read('xl/sharedStrings.xml')).findall('m:si',N)]
    out=[]
    for name in sorted(z.namelist()):
        if not re.match(r'xl/worksheets/sheet\d+.xml$',name): continue
        rows=[]
        for row in ET.fromstring(z.read(name)).findall('m:sheetData/m:row',N):
            values={}
            for c in row.findall('m:c',N):
                v=c.find('m:v',N);value=v.text if v is not None else ''
                if c.get('t')=='s' and value:value=ss[int(value)]
                elif c.get('t')=='inlineStr':value=''.join(c.find('m:is',N).itertext())
                values[re.sub(r'\d','',c.get('r'))]=value
            rows.append(values)
        out.append((name,rows))
    return out
summary=sheets(P/'trinity/data/Data_Summary.xlsx')[0][1];rows=summary[1:]
counts=collections.Counter(r.get('D','').strip().lower() for r in rows);running=[r for r in rows if r.get('D','').strip().lower()=='running']
stages=[];labels=[];issues=[];headers=collections.Counter();example=None
for r in running:
    name=r['B']; ss=sheets(P/'trinity/data'/name)
    for sheet,rr in ss:
        if not rr:continue
        first=rr[0]
        if any('VO2' in v for v in first.values()) and any(v=='HR' for v in first.values()):
            headers[tuple(first.values())]+=1
            if example is None:example={'file':name,'headers':first,'rows':rr[:4]}
            for i,row in enumerate(rr[1:]):
                try:
                    speed=float(row.get('A',''));hr=float(row.get('B',''));vo2=float(row.get('C',''));lactate=float(row.get('D',''))
                except ValueError:
                    issues.append({'file':name,'row':i+2,'issue':'missing_or_non_numeric_stage'});continue
                stages.append({'test_id':name.removesuffix('.xlsx'),'stage_index':i,'speed_kmh':speed,'hr_bpm':hr,'vo2_ml_kg_min':vo2,'lactate_mmol_l':lactate,'duration_s':180,'hr_aggregation':'last_minute_stage_mean','lactate_sample_offset_s':120,'duration_source':'published_protocol_not_recorded_sample_times'})
        if any('Tlac' in str(v) for row in rr for v in row.values()):
            lab={row.get('A'):row.get('B') for row in rr}
            labels.append({'test_id':name.removesuffix('.xlsx'),'label_type':'lab_lactate_breakpoint_segmented_regression','speed_kmh':lab.get('Load @ Tlac') or lab.get('Velocity @ Tlac'),'hr_bpm':lab.get('HR @ Tlac'),'source_test_sha256':hashlib.sha256((P/'trinity/data'/name).read_bytes()).hexdigest(),'not_60min_ground_truth':True})
with (P/'trinity-running-stages.csv').open('w') as f:
    w=csv.DictWriter(f,fieldnames=list(stages[0]));w.writeheader();w.writerows(stages)
(P/'trinity-running-labels.json').write_text(json.dumps(labels,indent=2))
report={'test_counts':dict(counts),'running_tests':len(running),'running_tests_with_stages':len(set(r['test_id'] for r in stages)),'stage_rows':len(stages),'running_labels':len(labels),'headers':[(list(k),v) for k,v in headers.items()],'bad_stage_rows':issues,'example':example,'identity':'file=test identifier; stable participant id not supplied','availability':'event test_date in summary; no first-available/sync timestamp; event-date retrospective only','label_nonempty_hr':sum(bool(x['hr_bpm']) for x in labels),'label_nonempty_speed':sum(bool(x['speed_kmh']) for x in labels)}
(P/'trinity-inspection.json').write_text(json.dumps(report,indent=2))
print(json.dumps({k:v for k,v in report.items() if k not in ('bad_stage_rows','example')},indent=2))
for n in ['trinity-running-stages.csv','trinity-running-labels.json']:
 b=(P/n).read_bytes();print(n,len(b),hashlib.sha256(b).hexdigest())
