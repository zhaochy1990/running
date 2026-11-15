import argparse,collections,csv,hashlib,json,pathlib,re,xml.etree.ElementTree as E,zipfile
parser=argparse.ArgumentParser(description='Extract local research workbook; never redistribute raw data')
parser.add_argument('--directory',required=True,type=pathlib.Path,help='local research directory outside Git')
P=parser.parse_args().directory.resolve();z=zipfile.ZipFile(P/'osf-60min-raw.xlsx');N={'x':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
ss=[''.join(e.itertext()) for e in E.fromstring(z.read('xl/sharedStrings.xml')).findall('x:si',N)]
def rows(sheet):
 for _,r in E.iterparse(z.open('xl/worksheets/'+sheet),events=('end',)):
  if r.tag!='{'+N['x']+'}row':continue
  d={}
  for c in r.findall('x:c',N):
   v=c.find('x:v',N);a=v.text if v is not None else ''
   if c.get('t')=='s' and a:a=ss[int(a)]
   if a:d[re.sub(r'\d','',c.get('r'))]=a
  r.clear();yield d
raw=collections.defaultdict(list)
for r in rows('sheet3.xml'):
 if r.get('B')=='60' and r.get('A'):raw[r['A']].append(r)
summary=[]
for person, rr in raw.items():
 times=[float(r['C']) for r in rr if 'C'in r]
 ds=[float(r['D']) for r in rr if 'D'in r];vs=[float(r['F']) for r in rr if 'F'in r]
 bins=collections.Counter(r.get('R') for r in rr)
 summary.append({'participant':person,'rows':len(rr),'time_min':min(times),'time_max':max(times),'time_order_regressions':sum(b<a for a,b in zip(times,times[1:])),'distance_km_first':ds[0],'distance_km_last':ds[-1],'speed_kmh_min':min(vs),'speed_kmh_max':max(vs),'five_min_bins':dict(bins),'hr_raw_present':False})
print('groups',len(raw),'counts',[(r['participant'],r['rows'],r['time_min'],r['time_max'],r['time_order_regressions']) for r in summary])
rs=list(rows('sheet1.xml'));labels=[]
for r in rs[2:]:
 if r.get('A') not in raw:continue
 labels.append({'participant':r['A'],'speed_summary_kmh':r.get('G'),'mean_hr':r.get('H'),'hr_5min':[r.get(k) for k in ['X','Y','Z','AA','AB','AC','AD','AE','AF','AG','AH','AI']],'rpe_5min':[r.get(k) for k in ['L','M','N','O','P','Q','R','S','T','U','V','W']],'speed_5min_kmh':[r.get(k) for k in ['DD','DE','DF','DG','DH','DI','DJ','DK','DL','DM','DN','DO']]})
(P/'osf-60min-summary.json').write_text(json.dumps({'raw_groups':summary,'labels':labels,'license_status':'OSF node_license null; article CC-BY4 with general CC0 data notice; external workbook lacks separate license declaration','availability':'no absolute event dates/first available timestamp in workbook; public file version created 2022-06-22 only'},indent=2))
print('labels',len(labels),'all12hr',sum(all(x['hr_5min']) for x in labels))
# Lossless domain-facing sample: leave actual source C elapsed untouched; keep both
# original distance and speed streams. No HR imputation, no artificial date.
with (P/'osf-60min-points.csv').open('w') as f:
 w=csv.writer(f);w.writerow(['participant','source_elapsed_s','distance_m','speed_mps','five_min_bin'])
 for person,rr in raw.items():
  for r in rr:w.writerow([person,r.get('C'),float(r['D'])*1000 if r.get('D') else '',float(r['F'])/3.6 if r.get('F') else '',r.get('R')])
for name in ['osf-60min-points.csv','osf-60min-summary.json']:
 b=(P/name).read_bytes();print(name,len(b),hashlib.sha256(b).hexdigest())
