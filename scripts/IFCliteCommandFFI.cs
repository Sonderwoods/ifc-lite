// Example Rhino command that imports IFC files using the ifc_lite_ffi.dll (in-process FFI).
// Compare with IFCliteCommand.cs which uses the HTTP server instead.
//
// Requirements:
//   - ifc_lite_ffi.dll must be next to your plugin assembly (or in a PATH-visible location).
//   - Build with /unsafe or <AllowUnsafeBlocks>true</AllowUnsafeBlocks> in your .csproj.
//
// Build the DLL:
//   cd ifc-lite
//   cargo build --release -p ifc-lite-ffi
//   cp target/release/ifc_lite_ffi.dll <your-plugin-output-dir>/

using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Rhino;
using Rhino.Commands;
using Rhino.DocObjects;
using Rhino.Geometry;

namespace IfcLiteExample
{
    // ─────────────────────────────────────────────────────────────────
    //  P/Invoke wrapper for ifc_lite_ffi.dll
    // ─────────────────────────────────────────────────────────────────

    /// <summary>
    /// Static P/Invoke wrapper for ifc_lite_ffi.dll.
    /// Place the DLL next to your plugin assembly.
    /// </summary>
    internal static unsafe class IfcLiteNative
    {
        private const string DllName = "ifc_lite_ffi";

        [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
        private static extern int ifc_lite_parse(
            byte* pathPtr, nuint pathLen,
            out byte* outPtr, out nuint outLen);

        [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
        private static extern int ifc_lite_parse_ex(
            byte* pathPtr, nuint pathLen,
            int openingFilterMode,
            out byte* outPtr, out nuint outLen);

        [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)]
        private static extern void ifc_lite_free(byte* ptr, nuint len);

        private static bool? _isAvailable;

        /// <summary>
        /// The absolute path where ifc_lite_ffi.dll is expected.
        /// </summary>
        public static string DllPath => Path.Combine(AssemblyDir, "ifc_lite_ffi.dll");

        /// <summary>
        /// Returns true if ifc_lite_ffi.dll exists next to the assembly.
        /// The result is cached after the first check.
        /// </summary>
        public static bool IsAvailable
        {
            get
            {
                _isAvailable ??= File.Exists(DllPath);
                return _isAvailable.Value;
            }
        }

        /// <summary>
        /// Parse an IFC file using the native FFI library.
        /// </summary>
        /// <param name="ifcPath">Absolute path to the IFC file.</param>
        /// <param name="openingFilter">Opening filter mode: 0=Default, 1=IgnoreAll, 2=IgnoreOpaque.</param>
        /// <exception cref="FileNotFoundException">Thrown when the DLL is not found.</exception>
        /// <exception cref="InvalidOperationException">Thrown when the native call returns a non-zero error code.</exception>
        public static ParseResponse ParseIfc(string ifcPath, int openingFilter = 0)
        {
            if (!IsAvailable)
            {
                throw new FileNotFoundException(
                    $"ifc_lite_ffi.dll not found at expected location: {DllPath}");
            }

            var pathBytes = Encoding.UTF8.GetBytes(ifcPath);

            byte* outPtr;
            nuint outLen;
            int result;

            fixed (byte* pathPtr = pathBytes)
            {
                result = openingFilter == 0
                    ? ifc_lite_parse(pathPtr, (nuint)pathBytes.Length, out outPtr, out outLen)
                    : ifc_lite_parse_ex(pathPtr, (nuint)pathBytes.Length, openingFilter, out outPtr, out outLen);
            }

            if (result != 0)
            {
                var reason = result switch
                {
                    1 => "invalid UTF-8 in file path",
                    2 => "could not read the IFC file",
                    3 => "geometry processing failed",
                    4 => "JSON serialization failed",
                    _ => $"unknown error code {result}"
                };
                throw new InvalidOperationException(
                    $"ifc_lite_parse returned error {result} ({reason}) for '{ifcPath}'.");
            }

            try
            {
                if (outPtr == null || outLen == 0)
                {
                    throw new InvalidOperationException(
                        $"ifc_lite_parse returned an empty payload for '{ifcPath}'.");
                }

                var jsonOptions = new JsonSerializerOptions
                {
                    PropertyNameCaseInsensitive = true
                };

                var jsonSpan = new ReadOnlySpan<byte>(outPtr, (int)outLen);
                return JsonSerializer.Deserialize<ParseResponse>(jsonSpan, jsonOptions)
                       ?? new ParseResponse();
            }
            finally
            {
                // Always free the Rust-allocated buffer, even if deserialization fails.
                ifc_lite_free(outPtr, outLen);
            }
        }

        private static string AssemblyDir =>
            Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location)
            ?? AppDomain.CurrentDomain.BaseDirectory;
    }

    // ─────────────────────────────────────────────────────────────────
    //  Rhino Command
    // ─────────────────────────────────────────────────────────────────

    public sealed class IfcLiteImportFromFfiCommand : Command
    {
        public override string EnglishName => "IfcLiteImportFromFFI";

        protected override Result RunCommand(RhinoDoc doc, RunMode mode)
        {
            try
            {
                if (!IfcLiteNative.IsAvailable)
                {
                    RhinoApp.WriteLine($"ifc_lite_ffi.dll not found at: {IfcLiteNative.DllPath}");
                    RhinoApp.WriteLine("Build it with: cargo build --release -p ifc-lite-ffi");
                    return Result.Failure;
                }

                var ifcPaths = SelectIfcFiles();
                if (ifcPaths.Length == 0)
                {
                    RhinoApp.WriteLine("No IFC files selected.");
                    return Result.Cancel;
                }

                RhinoApp.WriteLine($"Selected {ifcPaths.Length} IFC file(s). Using native FFI.");

                // Opening filter: 0=Default, 1=IgnoreAll, 2=IgnoreOpaque
                // Change this to suit your workflow.
                const int openingFilter = 0;

                int totalAdded = 0;
                int processedFiles = 0;
                int failedFiles = 0;
                var layerCache = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);

                for (int i = 0; i < ifcPaths.Length; i++)
                {
                    var ifcPath = ifcPaths[i];
                    var fileName = Path.GetFileName(ifcPath);

                    if (!File.Exists(ifcPath))
                    {
                        RhinoApp.WriteLine($"[{i + 1}/{ifcPaths.Length}] File not found: {ifcPath}");
                        failedFiles++;
                        continue;
                    }

                    RhinoApp.WriteLine($"[{i + 1}/{ifcPaths.Length}] Parsing {fileName} via FFI...");

                    var sw = System.Diagnostics.Stopwatch.StartNew();
                    ParseResponse parse;
                    try
                    {
                        parse = IfcLiteNative.ParseIfc(ifcPath, openingFilter);
                    }
                    catch (Exception ex)
                    {
                        RhinoApp.WriteLine($"[{i + 1}/{ifcPaths.Length}] FFI parse failed: {ex.Message}");
                        failedFiles++;
                        continue;
                    }
                    sw.Stop();

                    if (parse?.Meshes is null || parse.Meshes.Count == 0)
                    {
                        RhinoApp.WriteLine($"[{i + 1}/{ifcPaths.Length}] No meshes returned for {fileName}.");
                        failedFiles++;
                        continue;
                    }

                    RhinoApp.WriteLine($"[{i + 1}/{ifcPaths.Length}] Parsed {parse.Meshes.Count} meshes in {sw.ElapsedMilliseconds} ms.");

                    if (parse.Stats is not null)
                    {
                        RhinoApp.WriteLine($"  Vertices: {parse.Stats.TotalVertices}, Triangles: {parse.Stats.TotalTriangles}, Rust time: {parse.Stats.TotalTimeMs} ms");
                    }

                    int addedInFile = 0;
                    foreach (var src in parse.Meshes)
                    {
                        var mesh = ToRhinoMesh(src);
                        if (mesh is null || !mesh.IsValid) continue;

                        var ifcType = string.IsNullOrWhiteSpace(src.IfcType) ? "IfcUnknown" : src.IfcType;
                        var layerIndex = GetOrCreateLayer(doc, ifcType, src.Color, layerCache);

                        var attr = new ObjectAttributes
                        {
                            LayerIndex = layerIndex,
                            ColorSource = ObjectColorSource.ColorFromLayer,
                            Name = src.Name ?? ""
                        };

                        // Store IFC metadata as user strings for downstream use.
                        if (!string.IsNullOrWhiteSpace(src.GlobalId))
                            attr.SetUserString("IfcGlobalId", src.GlobalId);
                        if (!string.IsNullOrWhiteSpace(src.IfcType))
                            attr.SetUserString("IfcType", src.IfcType);
                        if (!string.IsNullOrWhiteSpace(src.MaterialName))
                            attr.SetUserString("IfcMaterial", src.MaterialName);
                        if (!string.IsNullOrWhiteSpace(src.PresentationLayer))
                            attr.SetUserString("IfcPresentationLayer", src.PresentationLayer);

                        if (doc.Objects.AddMesh(mesh, attr) != Guid.Empty) addedInFile++;
                    }

                    processedFiles++;
                    totalAdded += addedInFile;
                    RhinoApp.WriteLine($"[{i + 1}/{ifcPaths.Length}] Imported {addedInFile} mesh objects from {fileName}.");
                }

                doc.Views.Redraw();
                RhinoApp.WriteLine($"Done. Files: {processedFiles} OK, {failedFiles} failed. Total meshes: {totalAdded}.");
                return Result.Success;
            }
            catch (Exception ex)
            {
                RhinoApp.WriteLine($"Import failed: {ex.Message}");
                return Result.Failure;
            }
        }

        private static string[] SelectIfcFiles()
        {
            using var dialog = new Rhino.UI.OpenFileDialog
            {
                Title = "Select IFC files to import (FFI mode)",
                Filter = "IFC Files (*.ifc)|*.ifc|All files (*.*)|*.*",
                MultiSelect = true
            };

            var result = dialog.ShowDialog();
            if (result != System.Windows.Forms.DialogResult.OK ||
                dialog.FileNames is null ||
                dialog.FileNames.Length == 0)
            {
                return Array.Empty<string>();
            }

            return dialog.FileNames;
        }

        private static Mesh ToRhinoMesh(MeshDto src)
        {
            if (src.Positions is null || src.Indices is null) return null;

            var m = new Mesh();

            for (int i = 0; i + 2 < src.Positions.Count; i += 3)
                m.Vertices.Add(src.Positions[i], src.Positions[i + 1], src.Positions[i + 2]);

            for (int i = 0; i + 2 < src.Indices.Count; i += 3)
                m.Faces.AddFace((int)src.Indices[i], (int)src.Indices[i + 1], (int)src.Indices[i + 2]);

            m.Normals.ComputeNormals();
            m.Compact();
            return m;
        }

        private static int GetOrCreateLayer(
            RhinoDoc doc,
            string layerName,
            float[] rgba,
            Dictionary<string, int> cache)
        {
            if (cache.TryGetValue(layerName, out var cachedIndex))
                return cachedIndex;

            var existingLayer = doc.Layers.FindName(layerName);
            if (existingLayer is not null)
            {
                cache[layerName] = existingLayer.Index;
                return existingLayer.Index;
            }

            var newLayer = new Layer
            {
                Name = layerName,
                Color = ToColor(rgba)
            };

            var newLayerIndex = doc.Layers.Add(newLayer);
            if (newLayerIndex < 0)
                newLayerIndex = doc.Layers.CurrentLayerIndex;

            cache[layerName] = newLayerIndex;
            return newLayerIndex;
        }

        private static System.Drawing.Color ToColor(float[] rgba)
        {
            if (rgba is null || rgba.Length < 4) return System.Drawing.Color.Gray;

            int r = Clamp255(rgba[0] * 255f);
            int g = Clamp255(rgba[1] * 255f);
            int b = Clamp255(rgba[2] * 255f);
            int a = Clamp255(rgba[3] * 255f);
            return System.Drawing.Color.FromArgb(a, r, g, b);
        }

        private static int Clamp255(float v) =>
            v < 0 ? 0 : v > 255 ? 255 : (int)v;
    }

    // ─────────────────────────────────────────────────────────────────
    //  DTOs — shared between FFI and server examples
    // ─────────────────────────────────────────────────────────────────

    public sealed class ParseResponse
    {
        [JsonPropertyName("meshes")]
        public List<MeshDto> Meshes { get; set; }

        [JsonPropertyName("mesh_coordinate_space")]
        public string MeshCoordinateSpace { get; set; }

        [JsonPropertyName("site_transform")]
        public double[] SiteTransform { get; set; }

        [JsonPropertyName("building_transform")]
        public double[] BuildingTransform { get; set; }

        [JsonPropertyName("metadata")]
        public MetadataDto Metadata { get; set; }

        [JsonPropertyName("stats")]
        public StatsDto Stats { get; set; }
    }

    public sealed class MeshDto
    {
        [JsonPropertyName("express_id")]
        public uint ExpressId { get; set; }

        [JsonPropertyName("ifc_type")]
        public string IfcType { get; set; }

        [JsonPropertyName("global_id")]
        public string GlobalId { get; set; }

        [JsonPropertyName("name")]
        public string Name { get; set; }

        [JsonPropertyName("presentation_layer")]
        public string PresentationLayer { get; set; }

        [JsonPropertyName("material_name")]
        public string MaterialName { get; set; }

        [JsonPropertyName("positions")]
        public List<float> Positions { get; set; }

        [JsonPropertyName("normals")]
        public List<float> Normals { get; set; }

        [JsonPropertyName("indices")]
        public List<uint> Indices { get; set; }

        [JsonPropertyName("color")]
        public float[] Color { get; set; }

        [JsonPropertyName("properties")]
        public Dictionary<string, string> Properties { get; set; }
    }

    public sealed class MetadataDto
    {
        [JsonPropertyName("schema_version")]
        public string SchemaVersion { get; set; }

        [JsonPropertyName("entity_count")]
        public int EntityCount { get; set; }

        [JsonPropertyName("geometry_entity_count")]
        public int GeometryEntityCount { get; set; }
    }

    public sealed class StatsDto
    {
        [JsonPropertyName("total_meshes")]
        public int TotalMeshes { get; set; }

        [JsonPropertyName("total_vertices")]
        public int TotalVertices { get; set; }

        [JsonPropertyName("total_triangles")]
        public int TotalTriangles { get; set; }

        [JsonPropertyName("total_time_ms")]
        public long TotalTimeMs { get; set; }

        [JsonPropertyName("from_cache")]
        public bool FromCache { get; set; }
    }
}
