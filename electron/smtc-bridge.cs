// SMTC 桥接(强类型 WinRT,Windows 11 26100 新版 API)
// 由 smtc-reader.ps1 用 csc.exe 编译为 dll 后加载。
// 引用 System32\WinMetadata 的契约元数据(Windows.Media.winmd /
// Windows.Foundation.winmd),彻底绕开 PS 5.1 的 __ComObject 绑定问题。
//
// Windows 11 26100 的 SMTC API 与旧版差异:
//   GetGlobalPropertiesAsync -> TryGetMediaPropertiesAsync
//   GetPlaybackInfo/GetTimelineProperties 改为同步方法
//   新增 TryChangeAutoRepeatModeAsync / TryChangeShuffleActiveAsync(播放模式控制)
// 异步等待用轮询 Status + GetResults,不依赖 System.Runtime.WindowsRuntime
// 的 AsTask(其引用的 "Windows" 聚合程序集与 System32 契约不兼容)。
using System;
using System.Threading;
using Windows.Media;
using Windows.Media.Control;

public static class SmtcBridge
{
    /// 异步等待超时:WinRT 操作偶发永不完成,若无超时 PS 进程会永久卡死,
    /// 导致桥接全部请求(状态/控制)超时无响应
    private const int AWAIT_TIMEOUT_MS = 3000;
    /// 会话管理器缓存(RequestAsync 开销大,进程内常驻复用)
    private static GlobalSystemMediaTransportControlsSessionManager _manager;

    private static T AwaitOp<T>(Windows.Foundation.IAsyncOperation<T> op)
    {
        var sw = System.Diagnostics.Stopwatch.StartNew();
        while (op.Status == Windows.Foundation.AsyncStatus.Started)
        {
            if (sw.ElapsedMilliseconds > AWAIT_TIMEOUT_MS)
            {
                try { op.Cancel(); } catch { /* ignore */ }
                throw new TimeoutException("SMTC async operation timed out");
            }
            Thread.Sleep(15);
        }
        return op.GetResults();
    }

    private static GlobalSystemMediaTransportControlsSessionManager GetManager()
    {
        if (_manager == null)
        {
            _manager = AwaitOp(GlobalSystemMediaTransportControlsSessionManager.RequestAsync());
        }
        return _manager;
    }

    /// 播放状态 → 匿名对象(PS 侧 ConvertTo-Json 序列化);无会话或失败返回 null
    public static object State()
    {
        try
        {
            var mgr = GetManager();
            var sessions = mgr.GetSessions();
            if (sessions == null || sessions.Count == 0) return null;
            var session = sessions[0];
            // 优先播放中的会话(否则取列表第一个,通常即最近活跃)
            for (int i = 0; i < sessions.Count; i++)
            {
                try
                {
                    if (sessions[i].GetPlaybackInfo().PlaybackStatus ==
                        GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing)
                    {
                        session = sessions[i];
                        break;
                    }
                }
                catch { /* 单个会话读取失败,继续尝试 */ }
            }
            var props = AwaitOp(session.TryGetMediaPropertiesAsync());
            var info = session.GetPlaybackInfo();
            var timeline = session.GetTimelineProperties();
            string title = props.Title ?? "";
            // 新版时间线无 Duration:时长取时间线跨度(EndTime - StartTime)
            // 与可 seek 终点(MaxSeekTime - StartTime)的较大值——部分客户端
            // (如 QQ音乐个别曲目)会把 MaxSeekTime 报成很小的值(实测 7 分
            // 17 秒的歌报 ~7s),而 EndTime 是完整时长;取大值保证时长不被
            // 错误截短,任一属性报错/报小都不影响。
            // 时间线各属性相对同一原点(StartTime),时长与进度都需减去它
            double startSec = timeline.StartTime.TotalSeconds;
            double endSec = timeline.EndTime.TotalSeconds;
            double maxSeekSec = timeline.MaxSeekTime.TotalSeconds;
            double duration = Math.Max(endSec - startSec, maxSeekSec - startSec);
            if (duration <= 0) duration = maxSeekSec;
            if (duration <= 0) duration = endSec;
            // 真实播放模式:从 SMTC PlaybackInfo 读取(客户端写入才会变化;
            // QQ音乐等客户端可能不写/不同步,前端据此显示真实系统状态)
            string playbackMode = "sequence";
            if (info.IsShuffleActive != null && info.IsShuffleActive.Value)
                playbackMode = "shuffle";
            else if (info.AutoRepeatMode != null && info.AutoRepeatMode.Value == MediaPlaybackAutoRepeatMode.Track)
                playbackMode = "repeat-one";
            else if (info.AutoRepeatMode != null && info.AutoRepeatMode.Value == MediaPlaybackAutoRepeatMode.List)
                playbackMode = "repeat-all";
            return new
            {
                sourceAppId = string.IsNullOrEmpty(session.SourceAppUserModelId) ? null : session.SourceAppUserModelId,
                track = string.IsNullOrWhiteSpace(title)
                    ? null
                    : new
                    {
                        title,
                        artist = props.Artist ?? "",
                        album = props.AlbumTitle ?? ""
                    },
                isPlaying = info.PlaybackStatus == GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing,
                position = Math.Round(Math.Max(timeline.Position.TotalSeconds - startSec, 0), 2),
                duration = Math.Round(duration, 2),
                modeSupported = true,
                playbackMode
            };
        }
        catch
        {
            return null;
        }
    }

    /// 控制指令 → 是否被客户端接受
    public static bool Control(string action, string positionArg)
    {
        try
        {
            var mgr = GetManager();
            var sessions = mgr.GetSessions();
            if (sessions == null || sessions.Count == 0) return false;
            var session = sessions[0];
            for (int i = 0; i < sessions.Count; i++)
            {
                try
                {
                    if (sessions[i].GetPlaybackInfo().PlaybackStatus ==
                        GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing)
                    {
                        session = sessions[i];
                        break;
                    }
                }
                catch { }
            }
            switch (action)
            {
                case "play": return AwaitOp(session.TryPlayAsync());
                case "pause": return AwaitOp(session.TryPauseAsync());
                case "next": return AwaitOp(session.TrySkipNextAsync());
                case "previous": return AwaitOp(session.TrySkipPreviousAsync());
                case "seek":
                    double seconds;
                    if (!double.TryParse(positionArg, out seconds)) return false;
                    // 参数为 long(100ns 计数),即 TimeSpan.Ticks
                    return AwaitOp(session.TryChangePlaybackPositionAsync(TimeSpan.FromSeconds(seconds).Ticks));
                case "repeat-one": return AwaitOp(session.TryChangeAutoRepeatModeAsync(MediaPlaybackAutoRepeatMode.Track));
                case "repeat-all": return AwaitOp(session.TryChangeAutoRepeatModeAsync(MediaPlaybackAutoRepeatMode.List));
                case "shuffle": return AwaitOp(session.TryChangeShuffleActiveAsync(true));
                case "shuffle-off": return AwaitOp(session.TryChangeShuffleActiveAsync(false));
                default: return false;
            }
        }
        catch
        {
            return false;
        }
    }
}
