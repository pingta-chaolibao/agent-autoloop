// A suspended launch joins its Job Object before any child can escape. The runner lives outside that job to publish exit.
using System;
using System.ComponentModel;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Management;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace AgentAutoloop {
  public static class WindowsJob {
    public static int Main(string[] args) {
      Dictionary<string,object> data=null;
      try {
        if(args[0]=="run") {
          data=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(File.ReadAllText(args[1],Encoding.UTF8));
          var arguments=((System.Collections.IEnumerable)data["args"]).Cast<string>().ToArray();
          Run((string)data["program"],arguments,(string)data["cwd"],(string)data["out"],(string)data["err"],(string)data["exit"],(string)data["stop"],(string)data["job"]);
        } else if(args[0]=="active") Console.Write(Active(args[1]));
        else if(args[0]=="desktop") Console.Write(Environment.UserInteractive && System.Diagnostics.Process.GetCurrentProcess().SessionId!=0 ? "yes" : "no");
        else if(args[0]=="stop") Stop(args[1]);
        else if(args[0]=="process") {
          int id=int.Parse(args[1]);
          using(var search=new ManagementObjectSearcher("SELECT CommandLine,CreationDate FROM Win32_Process WHERE ProcessId="+id))
          using(var results=search.Get()) foreach(ManagementObject item in results) {
            var info=new Dictionary<string,string>(); info["command"]=(string)item["CommandLine"];
            info["created"]=ManagementDateTimeConverter.ToDateTime((string)item["CreationDate"]).ToUniversalTime().Ticks.ToString();
            Console.OutputEncoding=new UTF8Encoding(false); Console.Write(new JavaScriptSerializer().Serialize(info));
          }
        } else throw new ArgumentException("Unknown Windows host operation");
        return 0;
      } catch(Exception error) {
        if(data!=null && args[0]=="run" && !File.Exists((string)data["exit"])) {
          File.AppendAllText((string)data["err"],error.ToString(),new UTF8Encoding(false));
          File.WriteAllText((string)data["exit"]+".tmp","1",new UTF8Encoding(false));
          File.Move((string)data["exit"]+".tmp",(string)data["exit"]);
        } else Console.Error.WriteLine(error);
        return 1;
      }
    }
    [StructLayout(LayoutKind.Sequential)] struct Security { public int Length; public IntPtr Descriptor; public int Inherit; }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
      public int Size; public string Reserved, Desktop, Title;
      public int X,Y,XSize,YSize,XCount,YCount,Fill,Flags; public short Show,ReservedSize;
      public IntPtr ReservedPointer,Input,Output,Error;
    }
    [StructLayout(LayoutKind.Sequential)] struct Process { public IntPtr Handle,Thread; public uint Id,ThreadId; }
    [StructLayout(LayoutKind.Sequential)] struct Accounting {
      public long User,Kernel,PeriodUser,PeriodKernel;
      public uint Faults,Total,Active,Terminated;
    }
    [StructLayout(LayoutKind.Sequential)] struct Limits {
      public long ProcessTime,JobTime; public uint Flags; public UIntPtr MinWorking,MaxWorking;
      public uint ActiveLimit; public UIntPtr Affinity; public uint Priority,Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct Io { public ulong ReadOps,WriteOps,OtherOps,ReadBytes,WriteBytes,OtherBytes; }
    [StructLayout(LayoutKind.Sequential)] struct Extended {
      public Limits Basic; public Io Io; public UIntPtr ProcessMemory,JobMemory,PeakProcessMemory,PeakJobMemory;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr OpenJobObject(uint access,bool inherit,string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref Extended value,uint size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,out Accounting value,uint size,IntPtr returned);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFile(string file,uint access,uint share,ref Security security,uint creation,uint flags,IntPtr template);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string application,StringBuilder command,IntPtr processAttributes,IntPtr threadAttributes,bool inherit,uint flags,IntPtr environment,string cwd,ref Startup startup,out Process process);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    static void Check(bool ok) { if(!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    static void Close(IntPtr handle) { if(handle!=IntPtr.Zero && handle!=new IntPtr(-1)) CloseHandle(handle); }
    static string Quote(string value) {
      var text=new StringBuilder("\""); int slashes=0;
      foreach(char c in value) {
        if(c=='\\') { slashes++; continue; }
        if(c=='"') { text.Append('\\',slashes*2+1); text.Append(c); slashes=0; continue; }
        text.Append('\\',slashes); slashes=0; text.Append(c);
      }
      text.Append('\\',slashes*2); text.Append('"'); return text.ToString();
    }
    static uint Count(IntPtr job) {
      Accounting state; Check(QueryInformationJobObject(job,1,out state,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero)); return state.Active;
    }
    public static uint Active(string name) {
      IntPtr job=OpenJobObject(4,false,name);
      if(job==IntPtr.Zero) { int error=Marshal.GetLastWin32Error(); if(error==2) return 0; throw new Win32Exception(error); }
      try { return Count(job); } finally { Close(job); }
    }
    public static void Stop(string name) {
      IntPtr job=OpenJobObject(8,false,name);
      if(job==IntPtr.Zero) { int error=Marshal.GetLastWin32Error(); if(error==2) return; throw new Win32Exception(error); }
      try { Check(TerminateJobObject(job,1223)); } finally { Close(job); }
    }
    public static void Run(string program,string[] arguments,string cwd,string output,string errorFile,string exit,string stop,string name) {
      IntPtr job=IntPtr.Zero,input=IntPtr.Zero,stdout=IntPtr.Zero,stderr=IntPtr.Zero;
      Process process=new Process(); uint code=1; bool assigned=false;
      try {
        if(File.Exists(stop)) { code=1223; return; }
        job=CreateJobObject(IntPtr.Zero,name); Check(job!=IntPtr.Zero);
        var limits=new Extended(); limits.Basic.Flags=0x2000;
        Check(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(Extended))));
        var security=new Security(); security.Length=Marshal.SizeOf(typeof(Security)); security.Inherit=1;
        stdout=CreateFile(output,0x40000000,7,ref security,2,0x80,IntPtr.Zero); Check(stdout!=new IntPtr(-1));
        stderr=CreateFile(errorFile,0x40000000,7,ref security,2,0x80,IntPtr.Zero); Check(stderr!=new IntPtr(-1));
        input=CreateFile("NUL",0x80000000,7,ref security,3,0x80,IntPtr.Zero); Check(input!=new IntPtr(-1));
        var startup=new Startup(); startup.Size=Marshal.SizeOf(typeof(Startup)); startup.Flags=0x100;
        startup.Input=input; startup.Output=stdout; startup.Error=stderr;
        var command=new StringBuilder(Quote(program)); foreach(string arg in arguments) command.Append(" ").Append(Quote(arg));
        Check(CreateProcess(program,command,IntPtr.Zero,IntPtr.Zero,true,0x08000404,IntPtr.Zero,cwd,ref startup,out process));
        Check(AssignProcessToJobObject(job,process.Handle)); assigned=true;
        Check(ResumeThread(process.Thread)!=0xffffffff);
        bool stopped=false;
        for(;;) {
          if(!stopped && File.Exists(stop)) { Check(TerminateJobObject(job,1223)); stopped=true; }
          bool ended=WaitForSingleObject(process.Handle,100)==0;
          if(ended && Count(job)==0) break;
          if(ended) Thread.Sleep(50);
        }
        Check(GetExitCodeProcess(process.Handle,out code));
      } catch(Exception error) {
        if(process.Handle!=IntPtr.Zero) { if(assigned) TerminateJobObject(job,1); else TerminateProcess(process.Handle,1); }
        Close(stdout); stdout=IntPtr.Zero; Close(stderr); stderr=IntPtr.Zero;
        File.AppendAllText(errorFile,error.ToString()+Environment.NewLine,new UTF8Encoding(false));
        code=1;
      } finally {
        Close(input); Close(stdout); Close(stderr); Close(process.Thread); Close(process.Handle); Close(job);
        File.WriteAllText(exit+".tmp",code.ToString(System.Globalization.CultureInfo.InvariantCulture),new UTF8Encoding(false));
        File.Move(exit+".tmp",exit);
      }
    }
  }
}
