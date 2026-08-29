using System.Runtime.CompilerServices;

// The parsing internals are tested directly: Arabic normalisation is where the subtle
// failures live (presentation forms, hamza variants, tatweel), and testing it only
// through the public parse result would make a diagnosis mean reading a regex backwards.
[assembly: InternalsVisibleTo("Walaa.Agent.Tests")]
