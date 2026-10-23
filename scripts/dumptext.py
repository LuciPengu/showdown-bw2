import sys, struct, json
rom_path, outdir = sys.argv[1], sys.argv[2]
rom = open(rom_path,'rb').read()
u16=lambda d,a: struct.unpack_from('<H',d,a)[0]
u32=lambda d,a: struct.unpack_from('<I',d,a)[0]
print('game code', rom[0xC:0x10], 'title', rom[0:12])
fnt_off,fnt_sz,fat_off,fat_sz = u32(rom,0x40),u32(rom,0x44),u32(rom,0x48),u32(rom,0x4C)
fnt = rom[fnt_off:fnt_off+fnt_sz]
def entries(d):
    i=d-0xF000; at=u32(fnt,i*8); nf=u16(fnt,i*8+4); out=[]
    while True:
        l=fnt[at]; at+=1
        if l==0: return out
        n=fnt[at:at+(l&0x7f)]; at+=l&0x7f
        if l&0x80: out.append(('d',n.decode(),u16(fnt,at))); at+=2
        else: out.append(('f',n.decode(),nf)); nf+=1
def lookup(path):
    parts=path.split('/'); d=0xF000
    for p in parts[:-1]: d=[e[2] for e in entries(d) if e[0]=='d' and e[1]==p][0]
    return [e[2] for e in entries(d) if e[0]=='f' and e[1]==parts[-1]][0]
def romfile(fid):
    s,e=u32(rom,fat_off+fid*8),u32(rom,fat_off+fid*8+4); return rom[s:e]
def narc(raw):
    assert raw[:4]==b'NARC'; at=u16(raw,0xC); btaf=gmif=None
    while at+8<=len(raw):
        m=raw[at:at+4]; sz=u32(raw,at+4)
        if m==b'BTAF': btaf=at
        if m==b'GMIF': gmif=at+8
        at+=sz
    n=u16(raw,btaf+8)
    return [raw[gmif+u32(raw,btaf+12+i*8):gmif+u32(raw,btaf+16+i*8)] for i in range(n)]
def decode(f):
    secs,ents=u16(f,0),u16(f,2)
    sec=u32(f,12); out=[]
    for i in range(ents):
        e=sec+4+i*8; off=u32(f,e); cnt=u16(f,e+4); st=sec+off
        codes=[u16(f,st+k*2) for k in range(cnt)]
        if codes:
            key=codes[-1]^0xFFFF
            for k in range(cnt-1,-1,-1):
                codes[k]^=key; key=((key>>3)|(key<<13))&0xFFFF
        if codes and codes[0]==0xF100:
            words=codes[1:]; codes=[]; acc=0; bits=0; done=False
            for w in words:
                acc|=w<<bits; bits+=16
                while bits>=9:
                    c=acc&0x1ff; acc>>=9; bits-=9
                    if c&0xff==0xff: done=True; break
                    if c>1: codes.append(c)
                if done: break
        if 0xFFFF in codes: codes=codes[:codes.index(0xFFFF)]
        out.append(codes)
    return out
WORD={0:'TRNAME',1:'PKNAME',2:'NICK',3:'TYPE',6:'ABILITY',7:'MOVE',9:'ITEM',12:'TRUENICK',14:'TRCLASS',15:'TYPE2'}
def tostr(codes):
    s='';i=0
    while i<len(codes):
        c=codes[i]; i+=1
        if c==0xF000:
            t=codes[i]; n=codes[i+1]; args=codes[i+2:i+2+n]; i+=2+n
            cat,idx=t>>8,t&0xff
            if cat==1: s+='{%s:%s}'%(WORD.get(idx,'W%d'%idx),','.join(map(str,args)))
            elif cat==2: s+='{NUM%d:%s}'%(idx+1,','.join(map(str,args)))
            else: s+='{%04X:%s}'%(t,','.join(map(str,args)))
            continue
        m={0x246D:'♂',0x246E:'♀',0x2467:'×',0x2468:'÷',0x246C:'…',0xFFFE:'\\n',0x2486:'[PK]',0x2487:'[MN]'}
        if c in m: s+=m[c]
        elif c<0x20: s+='<%02X>'%c
        else: s+=chr(c)
    return s
for arc in ('a/0/0/2','a/0/0/3'):
    fid=lookup(arc); files=narc(romfile(fid)); print(arc,'fileid',fid,'count',len(files))
sysfiles=narc(romfile(lookup('a/0/0/2')))
for n in map(int,sys.argv[3:]):
    strs=[tostr(c) for c in decode(sysfiles[n])]
    json.dump(strs,open('%s/sys_%d.json'%(outdir,n),'w'),ensure_ascii=False,indent=0)
    with open('%s/sys_%d.txt'%(outdir,n),'w') as fo:
        for i,s in enumerate(strs): fo.write('%d\t0x%x\t%s\n'%(i,i,s))
    print(n,len(strs))
