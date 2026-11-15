"""Bounded local research sampler. Does not redistribute data or execute dataset code."""
import argparse, ast, hashlib, json, pathlib, time, urllib.request, zlib
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--directory', required=True, type=pathlib.Path, help='local research directory outside Git')
OUT = parser.parse_args().directory.resolve()
OUT.mkdir(parents=True, exist_ok=True)
URL = 'https://mcauleylab.ucsd.edu/public_datasets/gdrive/fitrec/endomondoHR.json.gz'
MAX_BYTES = 8 * 1024 * 1024

def decode_literal(text):
    # Source calls this JSON but actually uses Python literals. Parse an allowlisted
    # syntax tree; reject calls, names, attributes, comprehensions and operators.
    if len(text) > 2 * 1024 * 1024:
        raise ValueError('record too large')
    root = ast.parse(text, mode='eval')
    if sum(1 for _ in ast.walk(root)) > 200000:
        raise ValueError('too many nodes')
    def convert(node, depth=0):
        if depth > 10: raise ValueError('too deep')
        if isinstance(node, ast.Constant) and isinstance(node.value, (str, int, float, bool, type(None))): return node.value
        if isinstance(node, ast.List): return [convert(v, depth+1) for v in node.elts]
        if isinstance(node, ast.Dict): return {convert(k, depth+1): convert(v, depth+1) for k,v in zip(node.keys,node.values)}
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.USub) and isinstance(node.operand, ast.Constant) and type(node.operand.value) in (int,float): return -node.operand.value
        raise ValueError('unsupported literal node: '+type(node).__name__)
    return convert(root.body)

def main():
    request = urllib.request.Request(URL, headers={'Range': f'bytes=0-{MAX_BYTES-1}'})
    decoder = zlib.decompressobj(16+zlib.MAX_WBITS)
    buf = b''; downloaded = 0; scanned = 0; selected = []; start = time.monotonic(); prefix_hash=hashlib.sha256()
    with urllib.request.urlopen(request,timeout=30) as response:
        while downloaded < MAX_BYTES and time.monotonic()-start < 90:
            chunk = response.read(min(65536, MAX_BYTES-downloaded))
            if not chunk: break
            downloaded += len(chunk); prefix_hash.update(chunk); buf += decoder.decompress(chunk)
            if len(buf)>4*1024*1024: raise ValueError('unbounded decompressed buffer')
            while b'\n' in buf:
                line,buf=buf.split(b'\n',1)
                if not line.strip(): continue
                record=decode_literal(line.decode()); scanned+=1
                if record.get('sport')=='run': selected.append(record)
                if len(selected)>=3:break
            if len(selected)>=3:break
    raw=''.join(json.dumps(x,sort_keys=True,separators=(',',':'))+'\n' for x in selected).encode()
    (OUT/'fitrec-running-sample.jsonl').write_bytes(raw)
    provenance={'url':URL,'license_url':'https://mcauleylab.ucsd.edu/public_datasets/gdrive/fitrec/FitRec-Project.html','purpose':'local noncommercial algorithm research only; no redistribution','compressed_bytes_read':downloaded,'compressed_prefix_sha256':prefix_hash.hexdigest(),'records_scanned':scanned,'sample_records':len(selected),'sample_sha256':hashlib.sha256(raw).hexdigest(),'selection':'first 3 sport=run complete literal records from bounded gzip prefix','retrieved_at':time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),'decoder':'allowlisted AST data-only parser; no code evaluation'}
    (OUT/'fitrec-sample-provenance.json').write_text(json.dumps(provenance,indent=2))
    print(json.dumps(provenance,indent=2))
if __name__=='__main__':main()
