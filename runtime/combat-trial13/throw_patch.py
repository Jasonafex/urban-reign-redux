import struct
from ur_actions import ACTION
GRAB=0x527658;EVENT=0x52ffd8;NEWGRAB=0x2647658;NEWEVENT=0x265ffd8

def append_throw(ram,actions,manifest,ids,banks,clone,R):
 attacker=clone('Jack5','Rotary Catapult',3112);victim=clone('Any victim','Rotary Catapult victim',49)
 # Native paired action states and recovery remain responsible for contact,
 # interruption, knockdown and returning control to both actors.
 for aid in [attacker,victim]:
  struct.pack_into('<hhh',actions,aid*64+4,-3 if aid==victim else -2,0,144)
  struct.pack_into('<I',actions,aid*64+0x28,0);struct.pack_into('<H',actions,aid*64+0x30,0)
  struct.pack_into('<HH',actions,aid*64+0x3c,0,0)
 banks.extend([(45,0x10000+attacker,(R/'rotary-attacker.gyu').read_bytes()),(0xfffffffe,0x10000+victim,(R/'rotary-victim.gyu').read_bytes())])
 grabs=bytearray(ram[GRAB:GRAB+838*42]);events=bytearray(ram[EVENT:EVENT+912*16])
 g=list(struct.unpack_from('<21h',grabs,0));g[0]=victim;g[18]=912;g[19]=1
 struct.pack_into('<H',actions,attacker*64+0x3a,838)
 grabs.extend(struct.pack('<21h',*g));events.extend(struct.pack('<8h',119,35,100,1,7,0,1,0))
 manifest[-2].update(source_ids=[789],victim_action=victim,impact_frame=119,damage=35)
 manifest[-1].update(source_ids=[790],paired_attacker=attacker)
 attacker=clone('Kazuya','Double Face Kick',3112);victim=clone('Any victim','Double Face Kick victim',49)
 for aid in [attacker,victim]:
  struct.pack_into('<hhh',actions,aid*64+4,-3 if aid==victim else -2,0,137)
  struct.pack_into('<I',actions,aid*64+0x28,0);struct.pack_into('<H',actions,aid*64+0x30,0)
  struct.pack_into('<HH',actions,aid*64+0x3c,0,0)
 banks.extend([(16,0x10000+attacker,(R/'facekick-attacker.gyu').read_bytes()),(0xfffffffe,0x10000+victim,(R/'facekick-victim.gyu').read_bytes())])
 g=list(struct.unpack_from('<21h',grabs,0));g[0]=victim;g[18]=913;g[19]=2
 struct.pack_into('<H',actions,attacker*64+0x3a,839)
 grabs.extend(struct.pack('<21h',*g))
 # Two contact minima in the paired source: right foot reaches face at25/62.
 for frame,damage in [(25,15),(62,20)]:events.extend(struct.pack('<8h',frame,damage,100,1,7,0,1,0))
 manifest[-2].update(source_ids=[786],victim_action=victim,impact_frames=[25,62],damage=35)
 manifest[-1].update(source_ids=[787],paired_attacker=attacker)
 import json
 catalog=json.loads((R/'remaining-throws/report.json').read_text())
 for name,key,character,contacts in [
  ('Jin','Tidal Wave',15,[(51,2),(52,2),(53,2),(54,2),(65,4),(171,28)]),
  ('Heihachi','Jumping Powerbomb',53,[(90,35)]),
  ('Heihachi','Freefall',53,[(113,23),(120,23)]),
  ('Kiryu','Blizzard Rush',46,[(17,5),(45,5),(68,5),(106,10),(137,20)])]:
  data=next(x for x in catalog if x['character']==name and x['label']==key)
  attacker=clone(name,key,3112);victim=clone('Any victim',key+' victim',49)
  for aid,role,part in zip([attacker,victim],['attacker','victim'],data['parts']):
   struct.pack_into('<h',actions,aid*64,0)
   struct.pack_into('<hhh',actions,aid*64+4,-3 if role=='victim' else -2,0,part['frames']-1)
   struct.pack_into('<II',actions,aid*64+0x28,0,0);struct.pack_into('<H',actions,aid*64+0x30,0)
   struct.pack_into('<HH',actions,aid*64+0x3c,0,0)
   # The borrowed victim's release flag exits paired state at frame 150,
   # even when its imported clip and action end are longer. Let the paired
   # clip finish before native grounded recovery takes over.
   if role=='victim':struct.pack_into('<H',actions,aid*64+0x20,0)
   banks.append((character if role=='attacker' else 0xfffffffe,0x10000+aid,(R/'remaining-throws'/f'{name}-{key}-{role}.gyu').read_bytes()))
  g=list(struct.unpack_from('<21h',grabs,0));g[0]=victim;g[18]=len(events)//16;g[19]=len(contacts)
  struct.pack_into('<H',actions,attacker*64+0x3a,len(grabs)//42);grabs.extend(struct.pack('<21h',*g))
  for frame,damage in contacts:events.extend(struct.pack('<8h',frame,damage,100,1,7,0,1,0))
  manifest[-2].update(source_ids=data['source_ids'][:1],victim_action=victim,impact_frames=[x[0] for x in contacts],damage=sum(x[1] for x in contacts),source_event_timing=True)
  manifest[-1].update(source_ids=data['source_ids'][1:],paired_attacker=attacker)
 return [(NEWGRAB,grabs),(NEWEVENT,events)]

def hooks(elf):
 result={}
 # This getter family is the only native code accessing paired-action data.
 # All source instructions are verified, and the low halves stay unchanged.
 for addr in range(0x2156a0,0x215d3c,4):
  old=struct.unpack_from('<I',elf,addr-0xff000)[0]
  if old>>26==15 and old&65535 in [0x52,0x53]:
   upper=0x264 if old&65535==0x52 else 0x266
   result[addr]=(old,(old&0xffff0000)|upper)
 return result

