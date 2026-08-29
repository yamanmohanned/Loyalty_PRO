using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Hosting.WindowsServices;
using Microsoft.Extensions.Logging;
using Walaa.Agent;
using Walaa.Agent.Delivery;

/// <summary>
/// The Print Capture Agent's entry point (CLAUDE_v3.md §4).
///
/// A Windows Service on the cashier PC. It starts with the machine, and the SCM's own
/// failure actions are the watchdog §4.6 rule 4 requires — for an in-path mode, the
/// window between a crash and a restart is a window in which the store cannot print, so
/// the restart is configured to be immediate.
/// </summary>

var settingsPath = Environment.GetEnvironmentVariable("WALAA_AGENT_SETTINGS")
    ?? Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
        "Walaa",
        "agent",
        "agent-settings.json");

var settings = AgentSettings.Load(settingsPath);

var builder = Host.CreateApplicationBuilder(args);

builder.Services.AddWindowsService(options => options.ServiceName = "WalaaPrintCapture");
builder.Logging.AddEventLog(options => options.SourceName = "Walaa Print Capture");

builder.Services.AddSingleton(settings);
builder.Services.AddSingleton(provider => new CaptureQueue(
    settings.QueueDirectory,
    provider.GetRequiredService<ILogger<CaptureQueue>>()));

builder.Services.AddHttpClient<IngestClient>(client =>
{
    client.BaseAddress = new Uri(settings.ManagerUrl);
    // Long enough for a busy manager machine, short enough that a queued backlog is not
    // held up by one stuck request.
    client.Timeout = TimeSpan.FromSeconds(20);
});

builder.Services.AddHostedService<AgentWorker>();

var host = builder.Build();

host.Services.GetRequiredService<ILogger<Program>>().LogInformation(
    "walaa print capture agent starting (settings: {Path}, service: {IsService})",
    settingsPath,
    WindowsServiceHelpers.IsWindowsService());

await host.RunAsync();

/// <summary>Named so the logger above has a category.</summary>
public partial class Program;
