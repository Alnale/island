// 灵动岛安装管理器。
// 不用 Electron:这份 Electron 从仓库目录启动会在窗口出现前以 0x80000003 退出。
// 本程序是普通 WinForms,双击即可打开,安装/卸载步骤与原向导一致。
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

internal static class InstallerApp
{
    internal const string AppName = "灵动岛";
    internal const string ExeName = "灵动岛安装管理器.exe";
    internal const string Version = "3.1.0";
    internal const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\灵动岛";

    [STAThread]
    private static void Main(string[] args)
    {
        bool forceUninstall = false;
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--uninstall") forceUninstall = true;
        }
        try
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new InstallerForm(forceUninstall));
        }
        catch (Exception ex)
        {
            try
            {
                string log = Path.Combine(Path.GetDirectoryName(Application.ExecutablePath), "installer-error.log");
                File.WriteAllText(log, ex.ToString());
            }
            catch { }
            MessageBox.Show(ex.Message, "灵动岛安装管理器");
        }
    }

    internal static string ExePath()
    {
        return Application.ExecutablePath;
    }

    internal static string ExeDir()
    {
        return Path.GetDirectoryName(ExePath());
    }

    internal static bool RunningFromUninstaller()
    {
        string parent = Path.GetFileName(ExeDir());
        return parent != null && parent.Equals("uninstaller", StringComparison.OrdinalIgnoreCase);
    }

    internal static string ReleaseDir()
    {
        string packaged = Path.Combine(ExeDir(), "resources", "release", AppName);
        if (File.Exists(Path.Combine(packaged, "electron", "electron.exe"))) return packaged;
        string built = Path.GetFullPath(Path.Combine(ExeDir(), "..", AppName));
        if (File.Exists(Path.Combine(built, "electron", "electron.exe"))) return built;
        return packaged;
    }

    internal static string DefaultInstallDir()
    {
        string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (string.IsNullOrEmpty(local)) local = Path.GetTempPath();
        return Path.Combine(local, "Programs", AppName);
    }

    internal static string RegInstallLocation()
    {
        try
        {
            using (RegistryKey key = Registry.CurrentUser.OpenSubKey(UninstallKey))
            {
                if (key == null) return "";
                object v = key.GetValue("InstallLocation");
                return v == null ? "" : v.ToString();
            }
        }
        catch
        {
            return "";
        }
    }

    internal static string InstalledExe(string dir)
    {
        return Path.Combine(dir, "electron", "electron.exe");
    }

    internal struct Found
    {
        public bool Installed;
        public string Dir;
    }

    internal static Found Detect()
    {
        Found found = new Found();
        if (RunningFromUninstaller())
        {
            string dir = Path.GetDirectoryName(ExeDir());
            found.Dir = dir;
            found.Installed = File.Exists(InstalledExe(dir));
            return found;
        }
        string fromReg = RegInstallLocation();
        if (!string.IsNullOrEmpty(fromReg) && File.Exists(InstalledExe(fromReg)))
        {
            found.Installed = true;
            found.Dir = fromReg;
            return found;
        }
        string def = DefaultInstallDir();
        if (File.Exists(InstalledExe(def)))
        {
            found.Installed = true;
            found.Dir = def;
            return found;
        }
        found.Dir = def;
        return found;
    }
}

internal sealed class InstallerForm : Form
{
    private readonly bool _forceUninstall;
    private readonly InstallerApp.Found _found;
    private readonly string _releaseDir;
    private readonly List<CheckBox> _tools = new List<CheckBox>();

    private Panel _installPane;
    private Panel _uninstallPane;
    private TextBox _dirBox;
    private CheckBox _desktop;
    private CheckBox _startMenu;
    private CheckBox _autostart;
    private ProgressBar _installBar;
    private Label _installStatus;
    private Button _installBtn;
    private Button _launchBtn;
    private CheckBox _deleteData;
    private ProgressBar _uninstallBar;
    private Label _uninstallStatus;
    private Button _uninstallBtn;
    private Button _switchBtn;
    private volatile bool _busy;

    public InstallerForm(bool forceUninstall)
    {
        _forceUninstall = forceUninstall;
        _found = InstallerApp.Detect();
        _releaseDir = InstallerApp.ReleaseDir();
        BuildUi();
        bool showUninstall = forceUninstall || InstallerApp.RunningFromUninstaller() || _found.Installed;
        ShowMode(showUninstall);
    }

    private void BuildUi()
    {
        Text = "灵动岛安装管理器";
        FormBorderStyle = FormBorderStyle.FixedSingle;
        MaximizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(720, 560);
        BackColor = Color.FromArgb(12, 14, 20);
        ForeColor = Color.White;
        Font = new Font("Microsoft YaHei UI", 10f);

        Label title = new Label();
        title.Text = "灵动岛";
        title.Font = new Font("Microsoft YaHei UI", 22f, FontStyle.Bold);
        title.ForeColor = Color.White;
        title.AutoSize = true;
        title.Location = new Point(28, 18);

        Label ver = new Label();
        ver.Text = "安装管理器  " + InstallerApp.Version;
        ver.ForeColor = Color.FromArgb(180, 180, 190);
        ver.AutoSize = true;
        ver.Location = new Point(32, 58);

        _switchBtn = new Button();
        _switchBtn.FlatStyle = FlatStyle.Flat;
        _switchBtn.ForeColor = Color.FromArgb(180, 176, 255);
        _switchBtn.BackColor = Color.FromArgb(12, 14, 20);
        _switchBtn.FlatAppearance.BorderColor = Color.FromArgb(70, 68, 110);
        _switchBtn.Size = new Size(88, 32);
        _switchBtn.Location = new Point(604, 24);
        _switchBtn.Click += delegate { ShowMode(_installPane.Visible); };

        _installPane = BuildInstallPane();
        _uninstallPane = BuildUninstallPane();
        Controls.Add(title);
        Controls.Add(ver);
        Controls.Add(_switchBtn);
        Controls.Add(_installPane);
        Controls.Add(_uninstallPane);
    }

    private Panel BuildInstallPane()
    {
        Panel pane = new Panel();
        pane.Location = new Point(0, 96);
        pane.Size = new Size(720, 464);
        pane.BackColor = Color.FromArgb(12, 14, 20);

        Label hint = new Label();
        hint.ForeColor = Color.FromArgb(190, 190, 200);
        hint.Location = new Point(32, 0);
        hint.Size = new Size(650, 36);
        if (!File.Exists(Path.Combine(_releaseDir, "electron", "electron.exe")))
        {
            hint.Text = "没有找到安装源。请先运行 node scripts/build-release.mjs。";
            hint.ForeColor = Color.FromArgb(255, 160, 150);
        }
        else if (_found.Installed)
        {
            hint.Text = "已安装在 " + _found.Dir + "。继续会覆盖该目录。";
        }
        else
        {
            hint.Text = "选择安装位置。桌面快捷方式和开始菜单可以稍后不用。";
        }

        Label dirLabel = new Label();
        dirLabel.Text = "安装位置";
        dirLabel.AutoSize = true;
        dirLabel.Location = new Point(32, 44);

        _dirBox = new TextBox();
        _dirBox.Location = new Point(32, 70);
        _dirBox.Size = new Size(520, 28);
        _dirBox.Text = _found.Installed ? _found.Dir : InstallerApp.DefaultInstallDir();
        _dirBox.BackColor = Color.FromArgb(24, 26, 34);
        _dirBox.ForeColor = Color.White;
        _dirBox.BorderStyle = BorderStyle.FixedSingle;

        Button browse = new Button();
        browse.Text = "浏览…";
        browse.Location = new Point(564, 68);
        browse.Size = new Size(120, 30);
        StyleButton(browse, false);
        browse.Click += delegate { PickDir(); };

        _desktop = MakeCheck("创建桌面快捷方式", 32, 114, true);
        _startMenu = MakeCheck("添加到开始菜单", 250, 114, true);
        _autostart = MakeCheck("开机自动启动", 470, 114, false);

        int y = 156;
        string toolsRoot = Path.Combine(_releaseDir, "electron", "resources", "tools");
        if (Directory.Exists(toolsRoot))
        {
            Label toolsLabel = new Label();
            toolsLabel.Text = "外部工具(可选)";
            toolsLabel.AutoSize = true;
            toolsLabel.Location = new Point(32, y);
            pane.Controls.Add(toolsLabel);
            y += 28;
            string[] names = Directory.GetDirectories(toolsRoot);
            for (int i = 0; i < names.Length; i++)
            {
                string id = Path.GetFileName(names[i]);
                CheckBox box = MakeCheck(ToolLabel(id), 32, y, true);
                box.Tag = id;
                _tools.Add(box);
                pane.Controls.Add(box);
                y += 32;
            }
        }

        _installBar = new ProgressBar();
        _installBar.Location = new Point(32, 340);
        _installBar.Size = new Size(652, 18);
        _installBar.Minimum = 0;
        _installBar.Maximum = 1000;

        _installStatus = new Label();
        _installStatus.Location = new Point(32, 366);
        _installStatus.Size = new Size(652, 40);
        _installStatus.ForeColor = Color.FromArgb(190, 190, 200);
        _installStatus.Text = "准备安装";

        _installBtn = new Button();
        _installBtn.Text = "安装";
        _installBtn.Location = new Point(560, 416);
        _installBtn.Size = new Size(124, 36);
        StyleButton(_installBtn, true);
        _installBtn.Click += delegate { BeginInstall(); };

        _launchBtn = new Button();
        _launchBtn.Text = "立即启动";
        _launchBtn.Location = new Point(420, 416);
        _launchBtn.Size = new Size(124, 36);
        _launchBtn.Visible = false;
        StyleButton(_launchBtn, true);
        _launchBtn.Click += delegate { LaunchInstalled(); };

        pane.Controls.Add(hint);
        pane.Controls.Add(dirLabel);
        pane.Controls.Add(_dirBox);
        pane.Controls.Add(browse);
        pane.Controls.Add(_desktop);
        pane.Controls.Add(_startMenu);
        pane.Controls.Add(_autostart);
        pane.Controls.Add(_installBar);
        pane.Controls.Add(_installStatus);
        pane.Controls.Add(_installBtn);
        pane.Controls.Add(_launchBtn);
        return pane;
    }

    private Panel BuildUninstallPane()
    {
        Panel pane = new Panel();
        pane.Location = new Point(0, 96);
        pane.Size = new Size(720, 464);
        pane.BackColor = Color.FromArgb(12, 14, 20);
        pane.Visible = false;

        Label lead = new Label();
        lead.Text = _found.Installed
            ? "将删除程序文件、快捷方式和卸载项。"
            : "没有检测到已安装的灵动岛。";
        lead.ForeColor = Color.FromArgb(190, 190, 200);
        lead.Location = new Point(32, 8);
        lead.Size = new Size(650, 28);

        Label where = new Label();
        where.Text = "安装位置  " + (_found.Dir ?? "");
        where.Location = new Point(32, 48);
        where.Size = new Size(650, 24);
        where.ForeColor = Color.White;

        string dataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "dynamic-island");
        _deleteData = MakeCheck("同时删除个人数据(" + dataDir + ")", 32, 88, false);
        _deleteData.ForeColor = Color.FromArgb(255, 170, 160);
        _deleteData.Width = 640;

        _uninstallBar = new ProgressBar();
        _uninstallBar.Location = new Point(32, 160);
        _uninstallBar.Size = new Size(652, 18);
        _uninstallBar.Maximum = 1000;

        _uninstallStatus = new Label();
        _uninstallStatus.Location = new Point(32, 188);
        _uninstallStatus.Size = new Size(652, 40);
        _uninstallStatus.ForeColor = Color.FromArgb(190, 190, 200);
        _uninstallStatus.Text = "准备卸载";

        _uninstallBtn = new Button();
        _uninstallBtn.Text = "卸载";
        _uninstallBtn.Location = new Point(560, 416);
        _uninstallBtn.Size = new Size(124, 36);
        _uninstallBtn.Enabled = _found.Installed;
        StyleButton(_uninstallBtn, true);
        _uninstallBtn.Click += delegate { BeginUninstall(); };

        pane.Controls.Add(lead);
        pane.Controls.Add(where);
        pane.Controls.Add(_deleteData);
        pane.Controls.Add(_uninstallBar);
        pane.Controls.Add(_uninstallStatus);
        pane.Controls.Add(_uninstallBtn);
        return pane;
    }

    private void ShowMode(bool uninstall)
    {
        if (_busy) return;
        if (uninstall && InstallerApp.RunningFromUninstaller() == false && !_found.Installed && !_forceUninstall)
        {
            MessageBox.Show(this, "没有检测到已安装的灵动岛。", "灵动岛安装管理器");
            uninstall = false;
        }
        _installPane.Visible = !uninstall;
        _uninstallPane.Visible = uninstall;
        bool canSwitch = !InstallerApp.RunningFromUninstaller();
        _switchBtn.Visible = canSwitch;
        _switchBtn.Text = uninstall ? "去安装" : "卸载";
    }

    private void PickDir()
    {
        using (FolderBrowserDialog dlg = new FolderBrowserDialog())
        {
            dlg.Description = "选择灵动岛的安装目录";
            dlg.SelectedPath = _dirBox.Text;
            if (dlg.ShowDialog(this) == DialogResult.OK) _dirBox.Text = dlg.SelectedPath;
        }
    }

    private void BeginInstall()
    {
        if (_busy) return;
        string dir = (_dirBox.Text ?? "").Trim();
        if (dir.Length == 0)
        {
            MessageBox.Show(this, "请先选择安装目录。", "灵动岛安装管理器");
            return;
        }
        if (!File.Exists(Path.Combine(_releaseDir, "electron", "electron.exe")))
        {
            MessageBox.Show(this, "安装源里没有 electron\\electron.exe。\n" + _releaseDir, "灵动岛安装管理器");
            return;
        }
        _busy = true;
        _installBtn.Enabled = false;
        _dirBox.Enabled = false;
        bool desktop = _desktop.Checked;
        bool startMenu = _startMenu.Checked;
        bool autostart = _autostart.Checked;
        List<string> tools = new List<string>();
        for (int i = 0; i < _tools.Count; i++)
        {
            if (_tools[i].Checked) tools.Add((string)_tools[i].Tag);
        }
        Thread thread = new Thread(delegate () { RunInstall(dir, desktop, startMenu, autostart, tools); });
        thread.IsBackground = true;
        thread.Start();
    }

    private void RunInstall(string dir, bool desktop, bool startMenu, bool autostart, List<string> tools)
    {
        try
        {
            SetInstall(20, "正在结束已打开的灵动岛…");
            StopInstalled(dir);
            SetInstall(40, "正在复制程序…");
            string toolRoot = Path.Combine(_releaseDir, "electron", "resources", "tools");
            bool hasTools = Directory.Exists(toolRoot);
            CopyTree(_releaseDir, dir, hasTools ? new SkipTools() : null, new ProgressCopy(this));
            if (hasTools)
            {
                for (int i = 0; i < tools.Count; i++)
                {
                    string src = Path.Combine(toolRoot, tools[i]);
                    if (!Directory.Exists(src)) continue;
                    string dest = Path.Combine(dir, "electron", "resources", "tools", tools[i]);
                    SetInstall(820, "正在安装 " + tools[i] + "…");
                    CopyTree(src, dest, null, null);
                }
            }
            string exe = InstallerApp.InstalledExe(dir);
            if (!File.Exists(exe)) throw new IOException("复制完成但没有找到 " + exe);

            List<string> warnings = new List<string>();
            SetInstall(900, "正在创建快捷方式…");
            if (desktop) TryStep(warnings, "桌面快捷方式", delegate () { CreateShortcut(DesktopLnk(), exe); });
            if (startMenu) TryStep(warnings, "开始菜单", delegate () { CreateShortcut(StartMenuLnk(), exe); });
            if (autostart) TryStep(warnings, "开机自启", delegate () { SetAutostart(exe); });
            SetInstall(960, "正在写入卸载项…");
            string uninstaller = InstallUninstaller(dir);
            TryStep(warnings, "卸载项", delegate () { WriteUninstallKey(dir, exe, uninstaller); });
            SetInstall(1000, "安装完成");
            BeginInvoke(new MethodInvoker(delegate () { FinishInstall(dir, warnings); }));
        }
        catch (Exception ex)
        {
            BeginInvoke(new MethodInvoker(delegate ()
            {
                _busy = false;
                _installBtn.Enabled = true;
                _dirBox.Enabled = true;
                _installStatus.Text = ex.Message;
                MessageBox.Show(this, ex.Message, "安装没有完成");
            }));
        }
    }

    private void FinishInstall(string dir, List<string> warnings)
    {
        _busy = false;
        _installBtn.Visible = false;
        _launchBtn.Visible = true;
        _launchBtn.Tag = dir;
        _installStatus.Text = warnings.Count == 0
            ? "已安装到 " + dir
            : "已安装到 " + dir + "。有 " + warnings.Count + " 项跳过:" + string.Join(";", warnings.ToArray());
    }

    private void LaunchInstalled()
    {
        string dir = _launchBtn.Tag as string;
        if (string.IsNullOrEmpty(dir)) return;
        string exe = InstallerApp.InstalledExe(dir);
        try
        {
            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = exe;
            psi.WorkingDirectory = Path.GetDirectoryName(exe);
            psi.UseShellExecute = true;
            Process.Start(psi);
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, ex.Message, "没能启动灵动岛");
        }
    }

    private void BeginUninstall()
    {
        if (_busy || !_found.Installed) return;
        _busy = true;
        _uninstallBtn.Enabled = false;
        bool deleteData = _deleteData.Checked;
        string dir = _found.Dir;
        Thread thread = new Thread(delegate () { RunUninstall(dir, deleteData); });
        thread.IsBackground = true;
        thread.Start();
    }

    private void RunUninstall(string dir, bool deleteData)
    {
        try
        {
            SetUninstall(150, "正在退出灵动岛…");
            StopInstalled(dir);
            SetUninstall(400, "正在移除快捷方式…");
            TryDelete(DesktopLnk());
            TryDelete(StartMenuLnk());
            SetUninstall(650, "正在清除注册表…");
            try { Registry.CurrentUser.DeleteSubKeyTree(InstallerApp.UninstallKey, false); } catch { }
            try
            {
                using (RegistryKey run = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", true))
                {
                    if (run != null) run.DeleteValue(InstallerApp.AppName, false);
                }
            }
            catch { }
            if (deleteData)
            {
                SetUninstall(820, "正在删除个人数据…");
                string data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "dynamic-island");
                try { if (Directory.Exists(data)) Directory.Delete(data, true); } catch { }
            }
            SetUninstall(1000, "卸载完成");
            BeginInvoke(new MethodInvoker(delegate () { FinishUninstall(dir); }));
        }
        catch (Exception ex)
        {
            BeginInvoke(new MethodInvoker(delegate ()
            {
                _busy = false;
                _uninstallBtn.Enabled = true;
                _uninstallStatus.Text = ex.Message;
            }));
        }
    }

    private void FinishUninstall(string dir)
    {
        _busy = false;
        _uninstallStatus.Text = "已卸载。";
        _uninstallBtn.Visible = false;
        string exeDir = InstallerApp.ExeDir();
        string root = dir.TrimEnd('\\');
        bool selfInside = exeDir.Equals(root, StringComparison.OrdinalIgnoreCase)
            || exeDir.StartsWith(root + "\\", StringComparison.OrdinalIgnoreCase);
        if (selfInside && !string.IsNullOrEmpty(dir))
        {
            string cmd = "/d /c ping -n 3 127.0.0.1 >nul & rmdir /s /q \"" + dir + "\"";
            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = Path.Combine(Environment.SystemDirectory, "cmd.exe");
            psi.Arguments = cmd;
            psi.CreateNoWindow = true;
            psi.UseShellExecute = false;
            Process.Start(psi);
            Close();
            return;
        }
        try { if (Directory.Exists(dir)) Directory.Delete(dir, true); } catch { }
    }

    private void SetInstall(int perThousand, string text)
    {
        BeginInvoke(new MethodInvoker(delegate ()
        {
            _installBar.Value = Math.Max(0, Math.Min(1000, perThousand));
            _installStatus.Text = text;
        }));
    }

    private void SetUninstall(int perThousand, string text)
    {
        BeginInvoke(new MethodInvoker(delegate ()
        {
            _uninstallBar.Value = Math.Max(0, Math.Min(1000, perThousand));
            _uninstallStatus.Text = text;
        }));
    }

    private sealed class SkipTools
    {
        public bool Skip(string rel)
        {
            string norm = rel.Replace('\\', '/');
            return norm.StartsWith("electron/resources/tools/", StringComparison.OrdinalIgnoreCase)
                || norm.Equals("electron/resources/tools", StringComparison.OrdinalIgnoreCase);
        }
    }

    private sealed class ProgressCopy
    {
        private readonly InstallerForm _form;
        private int _lastTick;
        public ProgressCopy(InstallerForm form) { _form = form; }
        public void Report(long done, long total, string file)
        {
            int now = Environment.TickCount;
            if (now - _lastTick < 150 && done < total) return;
            _lastTick = now;
            int pct = 40 + (int)(760L * done / Math.Max(1, total));
            string mb = (done / 1048576L) + " / " + (total / 1048576L) + " MB";
            _form.SetInstall(pct, "正在复制  " + mb + "  " + file);
        }
    }

    private static void CopyTree(string src, string dest, SkipTools skip, ProgressCopy progress)
    {
        List<string> rels = new List<string>();
        List<string> abs = new List<string>();
        List<long> sizes = new List<long>();
        Collect(src, "", rels, abs, sizes);
        long total = 0;
        List<int> keep = new List<int>();
        for (int i = 0; i < rels.Count; i++)
        {
            if (skip != null && skip.Skip(rels[i])) continue;
            keep.Add(i);
            total += sizes[i];
        }
        long done = 0;
        for (int n = 0; n < keep.Count; n++)
        {
            int i = keep[n];
            string target = Path.Combine(dest, rels[i]);
            Directory.CreateDirectory(Path.GetDirectoryName(target));
            File.Copy(abs[i], target, true);
            done += sizes[i];
            if (progress != null) progress.Report(done, total, rels[i]);
        }
    }

    private static void Collect(string dir, string rel, List<string> rels, List<string> abs, List<long> sizes)
    {
        string[] files = Directory.GetFiles(dir);
        for (int i = 0; i < files.Length; i++)
        {
            string name = Path.GetFileName(files[i]);
            string childRel = rel.Length == 0 ? name : Path.Combine(rel, name);
            FileInfo info = new FileInfo(files[i]);
            rels.Add(childRel);
            abs.Add(files[i]);
            sizes.Add(info.Length);
        }
        string[] subs = Directory.GetDirectories(dir);
        for (int i = 0; i < subs.Length; i++)
        {
            string name = Path.GetFileName(subs[i]);
            if (name.Equals("uninstaller", StringComparison.OrdinalIgnoreCase)) continue;
            string childRel = rel.Length == 0 ? name : Path.Combine(rel, name);
            Collect(subs[i], childRel, rels, abs, sizes);
        }
    }

    private static void StopInstalled(string dir)
    {
        string exe = InstallerApp.InstalledExe(dir);
        Process[] list = Process.GetProcessesByName("electron");
        for (int i = 0; i < list.Length; i++)
        {
            try
            {
                string path = list[i].MainModule.FileName;
                if (path != null && path.Equals(exe, StringComparison.OrdinalIgnoreCase)) list[i].Kill();
            }
            catch { }
        }
    }

    private static string InstallUninstaller(string installDir)
    {
        string targetDir = Path.Combine(installDir, "uninstaller");
        Directory.CreateDirectory(targetDir);
        string dest = Path.Combine(targetDir, InstallerApp.ExeName);
        if (!InstallerApp.ExePath().Equals(dest, StringComparison.OrdinalIgnoreCase))
        {
            File.Copy(InstallerApp.ExePath(), dest, true);
        }
        return dest;
    }

    private static void WriteUninstallKey(string installDir, string exe, string uninstaller)
    {
        using (RegistryKey key = Registry.CurrentUser.CreateSubKey(InstallerApp.UninstallKey))
        {
            key.SetValue("DisplayName", InstallerApp.AppName);
            key.SetValue("DisplayVersion", InstallerApp.Version);
            key.SetValue("Publisher", "灵动岛");
            key.SetValue("InstallLocation", installDir);
            key.SetValue("DisplayIcon", exe);
            key.SetValue("UninstallString", "\"" + uninstaller + "\" --uninstall");
            key.SetValue("NoModify", 1, RegistryValueKind.DWord);
            key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
        }
    }

    private static void SetAutostart(string exe)
    {
        using (RegistryKey key = Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run"))
        {
            key.SetValue(InstallerApp.AppName, "\"" + exe + "\"");
        }
    }

    private static void CreateShortcut(string lnkPath, string exe)
    {
        string dir = Path.GetDirectoryName(lnkPath);
        if (!Directory.Exists(dir)) Directory.CreateDirectory(dir);
        Type shellType = Type.GetTypeFromProgID("WScript.Shell");
        object shell = Activator.CreateInstance(shellType);
        object shortcut = shellType.InvokeMember("CreateShortcut", System.Reflection.BindingFlags.InvokeMethod, null, shell, new object[] { lnkPath });
        Type shortcutType = shortcut.GetType();
        shortcutType.InvokeMember("TargetPath", System.Reflection.BindingFlags.SetProperty, null, shortcut, new object[] { exe });
        shortcutType.InvokeMember("WorkingDirectory", System.Reflection.BindingFlags.SetProperty, null, shortcut, new object[] { Path.GetDirectoryName(exe) });
        shortcutType.InvokeMember("IconLocation", System.Reflection.BindingFlags.SetProperty, null, shortcut, new object[] { exe + ",0" });
        shortcutType.InvokeMember("Description", System.Reflection.BindingFlags.SetProperty, null, shortcut, new object[] { InstallerApp.AppName });
        shortcutType.InvokeMember("Save", System.Reflection.BindingFlags.InvokeMethod, null, shortcut, null);
    }

    private static string DesktopLnk()
    {
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), InstallerApp.AppName + ".lnk");
    }

    private static string StartMenuLnk()
    {
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), InstallerApp.AppName + ".lnk");
    }

    private static void TryDelete(string path)
    {
        try { if (File.Exists(path)) File.Delete(path); } catch { }
    }

    private static void TryStep(List<string> warnings, string label, MethodInvoker action)
    {
        try { action(); }
        catch (Exception ex) { warnings.Add(label + ":" + ex.Message); }
    }

    private static string ToolLabel(string id)
    {
        if (id == "bili") return "哔哩哔哩下载工具";
        if (id == "docflow") return "文档流工具";
        return id;
    }

    private static CheckBox MakeCheck(string text, int x, int y, bool on)
    {
        CheckBox box = new CheckBox();
        box.Text = text;
        box.Checked = on;
        box.AutoSize = true;
        box.Location = new Point(x, y);
        box.ForeColor = Color.White;
        return box;
    }

    private static void StyleButton(Button button, bool primary)
    {
        button.FlatStyle = FlatStyle.Flat;
        button.ForeColor = Color.White;
        button.BackColor = primary ? Color.FromArgb(110, 99, 255) : Color.FromArgb(32, 34, 44);
        button.FlatAppearance.BorderSize = primary ? 0 : 1;
        button.FlatAppearance.BorderColor = Color.FromArgb(70, 72, 86);
    }
}
