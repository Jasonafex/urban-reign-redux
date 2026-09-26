using System;
using System.IO;
using System.Linq;
using System.Text;
using System.Collections.Generic;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Windows.Forms;
using System.Web.Script.Serialization;

// Per-game companion setup. No emulator launch, global settings or ISO writes.
static class ExpansionSetup {
 const string Start="// BEGIN REDUX MANAGED CAMERA",End="// END REDUX MANAGED CAMERA";
 public static string ExpandedBuildId(string iso){
  var volume=ReadAt(iso,32768,2048);if(Encoding.ASCII.GetString(volume,1,5)!="CD001")throw new Exception("Could not inspect the built ISO.");
  uint size=BitConverter.ToUInt32(volume,166);if(size>1048576)throw new Exception("Invalid ISO root.");
  var root=ReadAt(iso,(long)BitConverter.ToUInt32(volume,158)*2048,(int)size);byte[] elf=null;
  for(int p=0;p<root.Length;){int n=root[p];if(n==0){p=(p/2048+1)*2048;continue;}if(n<34||p+n>root.Length||33+root[p+32]>n)throw new Exception("Invalid ISO directory.");
   if(Encoding.ASCII.GetString(root,p+33,root[p+32])=="SLUS_212.09;1"){uint len=BitConverter.ToUInt32(root,p+10);if(len>33554432)throw new Exception("Unexpected executable size.");elf=ReadAt(iso,(long)BitConverter.ToUInt32(root,p+2)*2048,(int)len);}p+=n;
  }
  if(elf==null||elf.Length<52||elf[0]!=127||Encoding.ASCII.GetString(elf,1,3)!="ELF")throw new Exception("Urban Reign executable not found.");
  bool expanded=false;uint ph=BitConverter.ToUInt32(elf,28);int stride=BitConverter.ToUInt16(elf,42),count=BitConverter.ToUInt16(elf,44);
  if(stride<32||(long)ph+(long)stride*count>elf.Length)throw new Exception("Invalid executable memory layout.");
  for(int i=0;i<count;i++){int p=(int)ph+i*stride;if(BitConverter.ToUInt32(elf,p)==1&&(long)BitConverter.ToUInt32(elf,p+8)+BitConverter.ToUInt32(elf,p+20)>0x2000000)expanded=true;}
  if(!expanded)return null;
  uint crc=0;for(int i=0;i+4<=elf.Length;i+=4)crc^=BitConverter.ToUInt32(elf,i);return crc.ToString("X8");
 }
 public static string AutoMemory(string iso,string emulator=""){
  string id=ExpandedBuildId(iso);if(id==null)return "Standard-memory build; no PCSX2 changes needed.";
  if(id!="AAC5DB56")throw new Exception("ISO built, but its expanded executable has no matching bundled runtime preset.");
  // CRC alone is insufficient: verify the exact executable before installing address-specific patches.
  var volume=ReadAt(iso,32768,2048);var root=ReadAt(iso,(long)BitConverter.ToUInt32(volume,158)*2048,(int)BitConverter.ToUInt32(volume,166));
  for(int p=0;p<root.Length;){int n=root[p];if(n==0){p=(p/2048+1)*2048;continue;}
   if(Encoding.ASCII.GetString(root,p+33,root[p+32])=="SLUS_212.09;1"){
    var elf=ReadAt(iso,(long)BitConverter.ToUInt32(root,p+2)*2048,(int)BitConverter.ToUInt32(root,p+10));
    if(Hash(elf)!="f9046378651ec3e3bc9e6895e5fb01022b37ad9be60a77fdb21de27599e86f09")throw new Exception("ISO built, but its executable differs from the bundled runtime preset.");
   }p+=n;
  }
  return ConfigureRuntime(emulator);
 }
 const string RuntimeStart="// BEGIN REDUX V02 RUNTIME",RuntimeEnd="// END REDUX V02 RUNTIME";
 public static string ResolveDataFolder(string emulator){
  if(!String.IsNullOrWhiteSpace(emulator)){
   string folder=File.Exists(emulator)?Path.GetDirectoryName(emulator):emulator;
   if(File.Exists(Path.Combine(folder,"inis","PCSX2.ini")))return Path.GetFullPath(folder);
   if(!Directory.Exists(folder))throw new Exception("The selected PCSX2 folder does not exist.");
   if(!Directory.GetFiles(folder,"pcsx2*.exe").Any())throw new Exception("Select the PCSX2 installation or its data folder.");
   if(File.Exists(Path.Combine(folder,"portable.ini")))throw new Exception("Start this portable PCSX2 once and close it before configuring Redux.");
  }
  string docs=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),"PCSX2");
  if(File.Exists(Path.Combine(docs,"inis","PCSX2.ini")))return docs;
  throw new Exception("PCSX2 data was not found. Select its data folder, or start PCSX2 once and close it before saving settings.");
 }
 static string FolderSetting(string folder,string key,string fallback){
  string section="";
  foreach(string line in File.ReadAllLines(Path.Combine(folder,"inis","PCSX2.ini"))){string s=line.Trim();if(s.StartsWith("["))section=s;else if(section=="[Folders]"&&s.Contains("=")){int eq=s.IndexOf('=');if(s.Substring(0,eq).Trim()==key){string value=s.Substring(eq+1).Trim();if(value.Length>0)return Path.GetFullPath(Path.IsPathRooted(value)?value:Path.Combine(folder,value));}}}
  return Path.Combine(folder,fallback);
 }
 class TextureFile {public string file,sha256;}
 static bool InstallTextures(string folder){
  string zip=Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"config","runtime-v02","textures.zip");if(!File.Exists(zip))return false;
  string destination=Path.GetFullPath(Path.Combine(FolderSetting(folder,"Textures","textures"),"SLUS-21209","replacements"));
  using(var archive=System.IO.Compression.ZipFile.OpenRead(zip)){
   TextureFile[] files;using(var r=new StreamReader(archive.GetEntry("manifest.json").Open()))files=new JavaScriptSerializer().Deserialize<TextureFile[]>(r.ReadToEnd());
   foreach(var item in files){string target=Path.GetFullPath(Path.Combine(destination,item.file));if(!target.StartsWith(destination+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase))throw new Exception("Invalid texture path");var entry=archive.GetEntry(item.file);if(entry==null||entry.Length>64*1024*1024)throw new Exception("Invalid texture package");byte[] data;using(var m=new MemoryStream()){using(var stream=entry.Open())stream.CopyTo(m);data=m.ToArray();}if(Hash(data)!=item.sha256)throw new Exception("Texture checksum failed");
    if(File.Exists(target)&&Hash(File.ReadAllBytes(target))==item.sha256)continue;
    Directory.CreateDirectory(Path.GetDirectoryName(target));if(File.Exists(target))File.Copy(target,target+".redux-backup-"+DateTime.Now.ToString("yyyyMMddHHmmssfff"));string temp=target+".redux-temp";File.WriteAllBytes(temp,data);if(File.Exists(target))File.Replace(temp,target,null);else File.Move(temp,target);
   }
  }return true;
 }
 public static string ConfigureRuntime(string emulator){
  if(Process.GetProcesses().Any(p=>p.ProcessName.StartsWith("pcsx2",StringComparison.OrdinalIgnoreCase)))throw new Exception("Close PCSX2 before saving its Redux setup.");
  string patch;
  using(var stream=System.Reflection.Assembly.GetExecutingAssembly().GetManifestResourceStream("ReduxRuntime.pnach")){
   if(stream==null)throw new Exception("The bundled Redux runtime patch is missing. Reinstall this app.");
   using(var memory=new MemoryStream()){stream.CopyTo(memory);var bytes=memory.ToArray();if(Hash(bytes)!="48c829356fe18d688fc04dd194f1a12d87839a68731b2310199487f710b685dd")throw new Exception("Bundled runtime patch checksum failed.");patch=Encoding.UTF8.GetString(bytes);}
  }
  string folder=ResolveDataFolder(emulator),cheats=Path.Combine(FolderSetting(folder,"Cheats","cheats"),"AAC5DB56.pnach");
  string existing=File.Exists(cheats)?File.ReadAllText(cheats):"";
  int a=existing.IndexOf(RuntimeStart),z=existing.IndexOf(RuntimeEnd);
  if((a>=0)!=(z>=0)||z>=0&&z<a)throw new Exception("The existing Redux runtime block is incomplete; restore its backup first.");
  if(a>=0)existing=existing.Remove(a,z+RuntimeEnd.Length-a);
  // Adopt the exact previously installed unmarked preset without duplicating it.
  if(existing.Replace("\r\n","\n").Trim()==patch.Replace("\r\n","\n").Trim())existing="";
  var writes=new HashSet<string>(patch.Replace("\r","").Split('\n').Where(l=>l.TrimStart().StartsWith("patch=")).Select(l=>String.Join(",",l.Trim().Split(',').Take(4))),StringComparer.OrdinalIgnoreCase);
  foreach(string line in existing.Replace("\r","").Split('\n'))if(line.TrimStart().StartsWith("patch=")&&writes.Contains(String.Join(",",line.Trim().Split(',').Take(4))))throw new Exception("An existing cheat overlaps Redux's runtime patch. Keep a backup and remove that conflicting patch before retrying.");
  string text=RuntimeStart+"\r\n"+patch.Replace("\r\n","\n").Replace("\n","\r\n").TrimEnd()+"\r\n"+RuntimeEnd+"\r\n"+existing.TrimStart();
  Save(cheats,text);
  string target=ConfigureMemory(folder,"AAC5DB56");
  string settings=Merge(File.ReadAllText(target),"EmuCore","EnableCheats","true");
  bool textures=InstallTextures(folder);if(textures)settings=Merge(settings,"EmuCore/GS","LoadTextureReplacements","true");Save(target,settings);
  return "Redux 0.2 memory and runtime patches are installed in "+folder+(textures?". HD textures installed.":". HD texture bundle not found; reinstall the full release for HD textures.");
 }
 public static string ConfigureMemory(string folder,string id){
  if(id.Length!=8||id.Any(c=>!Uri.IsHexDigit(c)))throw new Exception("Invalid game identifier.");
  if(!File.Exists(Path.Combine(folder,"inis","PCSX2.ini")))throw new Exception("Choose the PCSX2 folder containing inis/PCSX2.ini.");
  string settingsFolder=Path.Combine(folder,"gamesettings"),section="";
  foreach(string line in File.ReadAllLines(Path.Combine(folder,"inis","PCSX2.ini"))){string s=line.Trim();if(s.StartsWith("["))section=s;else if(section=="[Folders]"&&s.Contains("=")){int eq=s.IndexOf('=');if(s.Substring(0,eq).Trim()=="GameSettings"){string value=s.Substring(eq+1).Trim();if(value.Length>0)settingsFolder=Path.IsPathRooted(value)?value:Path.Combine(folder,value);}}}
  string target=Path.Combine(settingsFolder,"SLUS-21209_"+id+".ini"),legacy=Path.Combine(settingsFolder,id+".ini");if(!File.Exists(target)&&File.Exists(legacy))target=legacy;
  Save(target,Merge(File.Exists(target)?File.ReadAllText(target):"","EmuCore/CPU","ExtraMemory","true"));return target;
 }
 public static string Merge(string text,string section,string key,string value){
  var lines=text.Replace("\r\n","\n").Split('\n').ToList();int begin=-1,finish=lines.Count;
  for(int i=0;i<lines.Count;i++)if(lines[i].Trim()=="["+section+"]"){begin=i;break;}
  if(begin<0){lines.Add("["+section+"]");lines.Add(key+" = "+value);}
  else {for(int i=begin+1;i<lines.Count;i++)if(lines[i].TrimStart().StartsWith("[")){finish=i;break;}
   bool found=false;for(int i=finish-1;i>begin;i--){string s=lines[i].Trim();int eq=s.IndexOf('=');if(eq>=0&&s.Substring(0,eq).Trim()==key){if(found)lines.RemoveAt(i);else {lines[i]=key+" = "+value;found=true;}}}
   if(!found)lines.Insert(begin+1,key+" = "+value);
  }return string.Join("\r\n",lines).TrimEnd()+"\r\n";
 }
 static string Hash(byte[] bytes){using(var h=SHA256.Create())return BitConverter.ToString(h.ComputeHash(bytes)).Replace("-","").ToLowerInvariant();}
 static byte[] ReadAt(string path,long offset,int size){using(var f=File.OpenRead(path)){if(offset<0||offset+size>f.Length)throw new Exception("This ISO does not match the supported Expansion Lab build.");f.Position=offset;var b=new byte[size];int p=0,n;while(p<size&&(n=f.Read(b,p,size-p))>0)p+=n;if(p!=size)throw new EndOfStreamException();return b;}}
 static void Save(string path,string data){Directory.CreateDirectory(Path.GetDirectoryName(path));if(File.Exists(path)){if(File.ReadAllText(path)==data)return;File.Copy(path,path+".redux-backup-"+DateTime.Now.ToString("yyyyMMddHHmmssfff"));}string temp=path+".redux-temp";File.WriteAllText(temp,data,new UTF8Encoding(false));if(File.Exists(path))File.Replace(temp,path,null);else File.Move(temp,path);}
 public static void Install(string iso,string dataFolder,bool camera,string presetFolder){
  if(Process.GetProcesses().Any(p=>p.ProcessName.StartsWith("pcsx2",StringComparison.OrdinalIgnoreCase)))throw new Exception("Close PCSX2 before saving its game settings.");
  if(!File.Exists(Path.Combine(dataFolder,"inis","PCSX2.ini")))throw new Exception("Choose the PCSX2 data folder containing inis/PCSX2.ini. You can find it using PCSX2's Open Data Directory command.");
  var m=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(File.ReadAllText(Path.Combine(presetFolder,"camera-preset.json")));
  var volume=ReadAt(iso,32768,2048);if(Encoding.ASCII.GetString(volume,1,5)!="CD001")throw new Exception("A plain ISO9660 game image is required.");
  uint rootSector=BitConverter.ToUInt32(volume,158),rootSize=BitConverter.ToUInt32(volume,166);if(rootSize>1048576)throw new Exception("Invalid ISO root directory.");
  var root=ReadAt(iso,(long)rootSector*2048,(int)rootSize);bool bootFound=false;
  for(int p=0;p<root.Length;){int n=root[p];if(n==0){p=(p/2048+1)*2048;continue;}if(n<34||p+n>root.Length)throw new Exception("Invalid ISO directory record.");
   string name=Encoding.ASCII.GetString(root,p+33,root[p+32]);if(name=="SLUS_212.09;1")bootFound=(long)BitConverter.ToUInt32(root,p+2)*2048==Convert.ToInt64(m["elf_offset"])&&BitConverter.ToUInt32(root,p+10)==Convert.ToInt32(m["elf_size"]);p+=n;
  }if(!bootFound)throw new Exception("The ISO boot executable does not match this preset.");
  var bytes=ReadAt(iso,Convert.ToInt64(m["elf_offset"]),Convert.ToInt32(m["elf_size"]));
  if(Hash(bytes)!=(string)m["elf_sha256"])throw new Exception("This setup supports a different game build. Obtain its matching setup preset before continuing.");
  uint crc=0;for(int i=0;i+4<=bytes.Length;i+=4)crc^=BitConverter.ToUInt32(bytes,i);
  string id=crc.ToString("X8");if(id!=(string)m["crc"])throw new Exception("Game identifier verification failed.");
  string patch=File.ReadAllText(Path.Combine(presetFolder,"redux-orbit-camera.pnach"));
  if(Hash(File.ReadAllBytes(Path.Combine(presetFolder,"redux-orbit-camera.pnach")))!=(string)m["patch_sha256"])throw new Exception("Camera preset is damaged.");
  string gs=Path.Combine(dataFolder,"gamesettings"),settings=Path.Combine(gs,(string)m["serial"]+"_"+id+".ini");
  string fallback=Path.Combine(gs,id+".ini");if(!File.Exists(settings)&&File.Exists(fallback))settings=fallback;
  string config=File.Exists(settings)?File.ReadAllText(settings):"";
  config=Merge(config,"EmuCore/CPU","ExtraMemory","true");
  string cheats=Path.Combine(dataFolder,"cheats",id+".pnach");
  if(camera){
   string existing=File.Exists(cheats)?File.ReadAllText(cheats):"";int a=existing.IndexOf(Start),z=existing.IndexOf(End);
   if((a>=0)!=(z>=0)||z>=0&&z<a)throw new Exception("An incomplete camera preset exists; restore its backup before installing.");
   if(a>=0)existing=existing.Remove(a,z+End.Length-a);
   if(Directory.Exists(Path.GetDirectoryName(cheats)))foreach(string file in Directory.GetFiles(Path.GetDirectoryName(cheats),"*.pnach")){
    string s=string.Equals(file,cheats,StringComparison.OrdinalIgnoreCase)?existing:File.ReadAllText(file);
    if((Path.GetFileName(file).IndexOf(id,StringComparison.OrdinalIgnoreCase)>=0||Path.GetFileName(file).IndexOf((string)m["serial"],StringComparison.OrdinalIgnoreCase)>=0)&&(s.IndexOf("4616C0",StringComparison.OrdinalIgnoreCase)>=0||s.IndexOf("4614D0",StringComparison.OrdinalIgnoreCase)>=0))throw new Exception("Another camera patch is installed for this game. Disable or remove that patch first.");
   }
   // Put the managed ungrouped block first, before any named cheat sections.
   Save(cheats,Start+"\r\n"+patch.Replace("\r\n","\n").Replace("\n","\r\n")+End+"\r\n"+existing.TrimStart());
   config=Merge(config,"EmuCore","EnableCheats","true");
  }
  Save(settings,config);
 }
 public static void Show(string presetFolder){
  using(var f=new Form()){f.Text="Set up Expansion Lab in PCSX2";f.Width=620;f.Height=270;f.StartPosition=FormStartPosition.CenterParent;
   var text=new Label{Left=20,Top=15,Width=565,Height=55,Text="One-time setup for the supported Expansion Lab. Afterwards, open your ISO normally in this PCSX2 installation. Close PCSX2 before setup."};f.Controls.Add(text);
   var iso=new TextBox{Left=20,Top=80,Width=440};var browse=new Button{Left=470,Top=78,Width=110,Text="Choose ISO"};f.Controls.Add(iso);f.Controls.Add(browse);
   browse.Click+=(s,e)=>{using(var d=new OpenFileDialog{Filter="Game ISO|*.iso"})if(d.ShowDialog()==DialogResult.OK)iso.Text=d.FileName;};
   var folder=new TextBox{Left=20,Top=115,Width=440};var locate=new Button{Left=470,Top=113,Width=110,Text="PCSX2 data"};f.Controls.Add(folder);f.Controls.Add(locate);
   locate.Click+=(s,e)=>{using(var d=new FolderBrowserDialog{Description="Select the PCSX2 data folder containing inis/PCSX2.ini"})if(d.ShowDialog()==DialogResult.OK)folder.Text=d.SelectedPath;};
   var camera=new CheckBox{Left=20,Top=155,Width=555,Text="Enable experimental multiplayer camera (L3 follows your player; R3 releases)"};f.Controls.Add(camera);
   var install=new Button{Left=20,Top=190,Width=180,Text="Save game setup"};f.Controls.Add(install);
   install.Click+=(s,e)=>{try{Install(iso.Text,folder.Text,camera.Checked,presetFolder);MessageBox.Show("Saved. Open this ISO normally in PCSX2. Camera controls still need in-game testing.");f.Close();}catch(Exception ex){MessageBox.Show(ex.Message,"Setup could not finish");}};
   f.ShowDialog();
  }
 }
 public static void Test(){string s="[Display]\r\nZoom = 123\r\n[EmuCore/CPU]\r\nExtraMemory = false\r\n[Pad]\r\nBinding = keep\r\n";string x=Merge(s,"EmuCore/CPU","ExtraMemory","true");if(!x.Contains("Zoom = 123")||!x.Contains("Binding = keep")||!x.Contains("ExtraMemory = true")||Merge(x,"EmuCore/CPU","ExtraMemory","true")!=x)throw new Exception("INI preservation test failed");Console.WriteLine("INI preservation and idempotence passed.");}
}

#if SETUP_STANDALONE
static class SetupProgram {
 [STAThread] static int Main(string[] args){try{if(args.Length>0&&args[0]=="--self-test"){ExpansionSetup.Test();return 0;}if(args.Length==2&&args[0]=="--configure"){Console.WriteLine(ExpansionSetup.ConfigureRuntime(args[1]));return 0;}if(args.Length==3&&args[0]=="--iso"){Console.WriteLine(ExpansionSetup.AutoMemory(args[1],args[2]));return 0;}if(args.Length==4&&args[0]=="--install"){ExpansionSetup.Install(args[1],args[2],true,args[3]);return 0;}Application.EnableVisualStyles();using(var d=new FolderBrowserDialog{Description="Select your PCSX2 installation or data folder"})if(d.ShowDialog()==DialogResult.OK)MessageBox.Show(ExpansionSetup.ConfigureRuntime(d.SelectedPath));return 0;}catch(Exception e){Console.Error.WriteLine(e.Message);return 1;}}
}
#endif
