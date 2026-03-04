using System;
using System.Collections.Generic;
using System.IO;
using System.Net.Http;
using System.Text.Json;
using System.Text.Json.Serialization;
using Rhino;
using Rhino.Commands;
using Rhino.DocObjects;
using Rhino.Geometry;

namespace LINK_EP.LINK_RH.Commands.IFC
{
    public sealed class IfcLiteImportFromServerCommand : Command
    {
        public override string EnglishName => "IfcLiteImportFromServer";

        static StopwatchHelper? sh = null;

        protected override Result RunCommand(RhinoDoc doc, RunMode mode)
        {
            sh = new StopwatchHelper();

            try
            {
                var healthOk = CheckHealth();
                if (!healthOk)
                {
                    RhinoApp.WriteLine("IFC server is not reachable at http://127.0.0.1:8080");
                    return Result.Failure;
                }

                var ifcPaths = SelectIfcFiles();
                if (ifcPaths.Length == 0)
                {
                    RhinoApp.WriteLine("No IFC files selected.");
                    return Result.Cancel;
                }

                RhinoApp.WriteLine($"Selected {ifcPaths.Length} IFC file(s).");

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

                    RhinoApp.WriteLine($"[{i + 1}/{ifcPaths.Length}] Importing {fileName}...");

                    if (sh is not null)
                    {
                        sh = new StopwatchHelper();
                    }

                    var parse = ParseIfc(ifcPath);
                    if (parse?.Meshes == null || parse.Meshes.Count == 0)
                    {
                        RhinoApp.WriteLine($"[{i + 1}/{ifcPaths.Length}] No meshes returned for {fileName}.");
                        failedFiles++;
                        continue;
                    }

                    int missingTypeCount = 0;
                    foreach (var m in parse.Meshes)
                    {
                        if (string.IsNullOrWhiteSpace(m.IfcType)) missingTypeCount++;
                    }
                    sh?.CreateOrAdd("CheckMeshes");
                    if (missingTypeCount > 0)
                    {
                        RhinoApp.WriteLine($"[{i + 1}/{ifcPaths.Length}] Warning: {missingTypeCount} meshes missing IFC type; they will be placed on IfcUnknown.");
                    }

                    int addedInFile = 0;
                    foreach (var src in parse.Meshes)
                    {
                        var mesh = ToRhinoMesh(src);
                        sh?.CreateOrAdd("To RhinoMesh");
                        if (mesh == null || !mesh.IsValid) continue;

                        var ifcType = string.IsNullOrWhiteSpace(src.IfcType) ? "IfcUnknown" : src.IfcType;
                        var layerIndex = GetOrCreateLayer(doc, ifcType, src.Color, layerCache);

                        var attr = new ObjectAttributes
                        {
                            LayerIndex = layerIndex,
                            ColorSource = ObjectColorSource.ColorFromLayer
                        };

                        if (doc.Objects.AddMesh(mesh, attr) != Guid.Empty) addedInFile++;
                        sh?.CreateOrAdd("Add mesh");
                    }

                    processedFiles++;
                    totalAdded += addedInFile;
                    RhinoApp.WriteLine($"[{i + 1}/{ifcPaths.Length}] Imported {addedInFile} mesh objects from {fileName}.");

                    if (sh is not null)
                    {
                        RhinoApp.WriteLine($"[{i + 1}/{ifcPaths.Length}] Timing details for {fileName}:");
                        RhinoApp.WriteLine(sh.GetOrderedOverview());
                    }
                }

                doc.Views.Redraw();
                RhinoApp.WriteLine($"Batch import complete. Files processed: {processedFiles}, failed: {failedFiles}, total meshes imported: {totalAdded}.");
                return Result.Success;
            }
            catch (Exception ex)
            {
                RhinoApp.WriteLine("Import failed: " + ex.Message);
                return Result.Failure;
            }
        }

        private static string[] SelectIfcFiles()
        {
            using var dialog = new Rhino.UI.OpenFileDialog
            {
                Title = "Select IFC files to import",
                Filter = "IFC Files (*.ifc)|*.ifc|All files (*.*)|*.*",
                MultiSelect = true
            };

            var result = dialog.ShowDialog();
            if (result != System.Windows.Forms.DialogResult.OK ||
                dialog.FileNames == null ||
                dialog.FileNames.Length == 0)
            {
                return Array.Empty<string>();
            }

            return dialog.FileNames;
        }

        private static bool CheckHealth()
        {
            using var http = new HttpClient { BaseAddress = new Uri("http://127.0.0.1:8080") };
            http.Timeout = TimeSpan.FromHours(1); // long timeout to allow server startup
            using var res = http.GetAsync("/api/v1/health").GetAwaiter().GetResult();

            return res.IsSuccessStatusCode;
        }

        private static ParseResponse ParseIfc(string ifcPath)
        {
            sh?.CreateOrAdd("");
            using var http = new HttpClient { BaseAddress = new Uri("http://127.0.0.1:8080") };
            sh?.CreateOrAdd("Create Client");
            using var form = new MultipartFormDataContent();
            sh?.CreateOrAdd("Form");
            using var fs = File.OpenRead(ifcPath);
            sh?.CreateOrAdd("Read file");

            form.Add(new StreamContent(fs), "file", Path.GetFileName(ifcPath));
            sh?.CreateOrAdd("Stream file");

            using var res = http.PostAsync("/api/v1/parse", form).GetAwaiter().GetResult();
            sh?.CreateOrAdd("IfcLite parsing");
            res.EnsureSuccessStatusCode();
            sh?.CreateOrAdd("Status Code");

            var json = res.Content.ReadAsStringAsync().GetAwaiter().GetResult();
            sh?.CreateOrAdd("Get Json");
            var x = JsonSerializer.Deserialize<ParseResponse>(json, new JsonSerializerOptions
            {
                PropertyNameCaseInsensitive = true
            });
            sh?.CreateOrAdd("Deserialize json");

            return x;
        }

        private static Mesh ToRhinoMesh(MeshDto src)
        {
            if (src.Positions == null || src.Indices == null) return null;

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
            {
                return cachedIndex;
            }

            var existingLayer = doc.Layers.FindName(layerName);
            if (existingLayer != null)
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
            {
                newLayerIndex = doc.Layers.CurrentLayerIndex;
            }

            cache[layerName] = newLayerIndex;
            return newLayerIndex;
        }

        private static System.Drawing.Color ToColor(float[] rgba)
        {
            if (rgba == null || rgba.Length < 4) return System.Drawing.Color.Gray;

            int r = Clamp255(rgba[0] * 255f);
            int g = Clamp255(rgba[1] * 255f);
            int b = Clamp255(rgba[2] * 255f);
            int a = Clamp255(rgba[3] * 255f);
            return System.Drawing.Color.FromArgb(a, r, g, b);
        }

        private static int Clamp255(float v)
        {
            if (v < 0) return 0;
            if (v > 255) return 255;
            return (int)v;
        }
    }

    public sealed class ParseResponse
    {
        [JsonPropertyName("meshes")]
        public List<MeshDto> Meshes { get; set; }
    }

    public sealed class MeshDto
    {
        [JsonPropertyName("ifc_type")]
        public string IfcType { get; set; }

        // Compatibility aliases for different payload shapes.
        [JsonPropertyName("ifcType")]
        public string IfcTypeCamel
        {
            get => IfcType;
            set
            {
                if (!string.IsNullOrWhiteSpace(value))
                {
                    IfcType = value;
                }
            }
        }

        [JsonPropertyName("type_name")]
        public string TypeName
        {
            get => IfcType;
            set
            {
                if (!string.IsNullOrWhiteSpace(value))
                {
                    IfcType = value;
                }
            }
        }

        [JsonPropertyName("typeName")]
        public string TypeNameCamel
        {
            get => IfcType;
            set
            {
                if (!string.IsNullOrWhiteSpace(value))
                {
                    IfcType = value;
                }
            }
        }

        [JsonPropertyName("positions")]
        public List<float> Positions { get; set; }

        [JsonPropertyName("indices")]
        public List<uint> Indices { get; set; }

        [JsonPropertyName("color")]
        public float[] Color { get; set; }
    }
}
