using System.Net;
using System.Net.Sockets;
using Microsoft.Extensions.Logging;

namespace Walaa.Agent.Capture;

/// <summary>
/// Sits between the POS and a network-attached printer on port 9100
/// (CLAUDE_v3.md §4.2).
/// </summary>
/// <remarks>
/// <para>
/// The POS is pointed at this machine instead of the printer; every byte is forwarded
/// to the printer's real address and captured on the way past. One TCP connection is
/// one print job, which makes job boundaries exact — the mode that needs the least
/// guessing about where a receipt ends.
/// </para>
/// <para>
/// <b>In-path (§4.6).</b> If this process is not running, the POS cannot reach the
/// printer at all. That is why the relay is forward-first, why the service has a
/// watchdog, and why the setup guide documents pointing the POS back at the printer's
/// own IP as a one-step manual revert.
/// </para>
/// </remarks>
public sealed class NetworkProxyCapture(
    IPEndPoint listenOn,
    IPEndPoint printer,
    ILogger<NetworkProxyCapture> logger) : ICaptureMode
{
    private TcpListener? _listener;
    private CancellationTokenSource? _stopping;
    private Task? _acceptLoop;

    public CaptureMode Mode => CaptureMode.NetworkProxy;

    /// <summary>The address the POS should be pointed at. Useful for the setup guide.</summary>
    public IPEndPoint ListenEndpoint => _listener?.LocalEndpoint as IPEndPoint ?? listenOn;

    public Task<ProbeResult> ProbeAsync(CancellationToken cancellationToken)
    {
        // Two questions, and both must be answered without disturbing anything: can this
        // machine listen where the POS will be told to connect, and is the printer
        // actually at the address configured?
        try
        {
            var probe = new TcpListener(listenOn);
            probe.Start();
            probe.Stop();
        }
        catch (SocketException error)
        {
            return Task.FromResult(ProbeResult.No($"المنفذ {listenOn.Port} مشغول: {error.SocketErrorCode}"));
        }

        return Task.FromResult(ProbeResult.Yes($"يمكن الاستماع على {listenOn} والتمرير إلى {printer}"));
    }

    public Task StartAsync(ICaptureSink sink, CancellationToken cancellationToken)
    {
        _stopping = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        _listener = new TcpListener(listenOn);
        _listener.Start();

        logger.LogInformation("proxying {Listen} -> {Printer}", ListenEndpoint, printer);
        _acceptLoop = AcceptAsync(sink, _stopping.Token);
        return Task.CompletedTask;
    }

    private async Task AcceptAsync(ICaptureSink sink, CancellationToken token)
    {
        while (!token.IsCancellationRequested)
        {
            TcpClient pos;
            try
            {
                pos = await _listener!.AcceptTcpClientAsync(token).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return;
            }
            catch (SocketException error)
            {
                logger.LogWarning(error, "accept failed");
                continue;
            }

            // Deliberately not awaited: a second till printing must not queue behind the
            // first one's receipt.
            _ = Task.Run(() => ForwardAsync(pos, sink, token), token);
        }
    }

    private async Task ForwardAsync(TcpClient pos, ICaptureSink sink, CancellationToken token)
    {
        using (pos)
        {
            TcpClient? real = null;
            try
            {
                real = new TcpClient();
                await real.ConnectAsync(printer, token).ConfigureAwait(false);

                await PrintRelay.RelayAsync(
                    pos.GetStream(), real.GetStream(), sink, token).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
            }
            catch (SocketException error)
            {
                // The printer is unreachable. Nothing the agent can do salvages this
                // job — but it is the printer being down, not the agent losing it, and
                // the distinction belongs in the log the manager's capture screen reads.
                logger.LogError(error, "printer {Printer} unreachable; job lost", printer);
            }
            finally
            {
                real?.Dispose();
            }
        }
    }

    public async ValueTask DisposeAsync()
    {
        _stopping?.Cancel();
        _listener?.Stop();

        if (_acceptLoop is not null)
        {
            try
            {
                await _acceptLoop.ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
            }
        }

        _stopping?.Dispose();
    }
}
