import xml.etree.ElementTree as E,re,csv,json,sys
from pathlib import Path
v=sys.argv[1];root=E.parse('/tmp/t25-'+v+'-signposts.xml').getroot();refs={e.attrib['id']:e for e in root.iter() if 'id' in e.attrib}
def val(e):return refs.get(e.get('ref'),e)
rows=[]
for row in root.iter('row'):
 es=[val(e) for e in row]
 if not any((e.text or '')=='si.eilmer.reflex.profile' for e in es):continue
 obj={e.tag:e for e in es};name=obj['signpost-name'].text;meta=obj['os-log-metadata'].get('fmt','');stroke=re.search(r'stroke=\s*(\d+)',meta)
 if not stroke:continue
 r={'time_ns':int(obj['event-time'].text),'event':name,'stroke':int(stroke[1]),'phase':'','gap_ms':''}
 if name=='InkFrame':
  r['phase']=int(re.search(r'phase=\s*(\d+)',meta)[1]);r['gap_ms']=float(next(val(e).text for e in obj['os-log-metadata'] if e.tag=='fixed-decimal'))
 rows.append(r)
with open('/tmp/t25-'+v+'-frames.csv','w') as f:
 w=csv.DictWriter(f,fieldnames=rows[0].keys(),lineterminator="\n");w.writeheader();w.writerows(rows)
def stats(a):
 a=sorted(a);n=len(a)
 return {'n':n,'median_ms':a[n//2] if n else None,'p95_ms':a[max(0,__import__('math').ceil(.95*n)-1)] if n else None,'max_ms':max(a) if n else None,'over_16_67_ms':sum(x>16.67 for x in a),'over_33_33_ms':sum(x>33.33 for x in a)}
first=set();frames=[]
for r in rows:
 if r['event']!='InkFrame':continue
 if r['stroke'] not in first:first.add(r['stroke']);continue
 frames.append(r)
report={'during':stats([r['gap_ms'] for r in frames if r['phase']==1]),'end_500ms':stats([r['gap_ms'] for r in frames if r['phase']==2]),'stroke_end_max_ms':{str(i):max([r['gap_ms'] for r in frames if r['stroke']==i and r['phase']==2],default=0) for i in range(1,7)},'stroke_windows':{str(i):{r['event']:r['time_ns'] for r in rows if r['stroke']==i and r['event']!='InkFrame'} for i in range(1,7)}}
Path('/tmp/t25-'+v+'-summary.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))
# Correlate Instruments' actual display hitches/app-update intervals with
# tool-up and the following 500 ms. Callback gaps alone are not hitch events.
for kind in ['hitches','updates']:
 root=E.parse('/tmp/t25-'+v+'-'+kind+'.xml').getroot()
 refs={e.attrib['id']:e for e in root.iter() if 'id' in e.attrib}
 cols=[e.findtext('mnemonic') for e in root.findall('.//schema/col')]
 events=[]
 for row in root.iter('row'):
  d=dict(zip(cols,[refs.get(e.get('ref'),e) for e in row]))
  start=int(d['start'].text); duration=int(d['duration'].text); end=start+duration
  phase='outside'; stroke=''
  for i,w in report['stroke_windows'].items():
   if end>=w['StrokeEnd'] and start<w['StrokeEnd']+500_000_000:
    phase='end';stroke=i;break
   if end>=w['StrokeBegin'] and start<w['StrokeEnd']:
    phase='drawing';stroke=i;break
  # Keep only this app's records, not system processes.
  if not d['process'].get('fmt','').startswith('Reflex ('):continue
  reason=d.get('narrative-description',d.get('frame-color')).get('fmt','')
  events.append({'start_ns':start,'duration_ms':duration/1e6,'phase':phase,'stroke':stroke,'reason':reason})
 with open('/tmp/t25-'+v+'-'+kind+'.csv','w') as f:
  w=csv.DictWriter(f,fieldnames=['start_ns','duration_ms','phase','stroke','reason'],lineterminator='\n');w.writeheader();w.writerows(events)
 if kind=='hitches':
  report['hitches']={phase:[e for e in events if e['phase']==phase] for phase in ['drawing','end','outside']}
 else:
  # Colored update rows can duplicate an interval; use max, never their sum.
  report['stroke_end_update_max_ms']={str(i):max([e['duration_ms'] for e in events if e['phase']=='end' and e['stroke']==str(i)],default=0) for i in range(1,7)}
Path('/tmp/t25-'+v+'-summary.json').write_text(json.dumps(report,indent=2))
