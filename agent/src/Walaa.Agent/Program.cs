using Walaa.Agent;

/// <remarks>
/// Placeholder host so the assembly has an entry point while the capture modes and the
/// delivery pipeline are built out. Replaced in the next slice.
/// </remarks>
var builder = Host.CreateApplicationBuilder(args);
builder.Services.AddWindowsService(options => options.ServiceName = "WalaaPrintCapture");
var host = builder.Build();
await host.RunAsync();
