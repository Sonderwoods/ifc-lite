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
using Rhino.Input;

namespace LINK_EP.LINK_RH.Commands.IFC
{
    public sealed class IfcLiteImportFromServerCommand : Command
    {
        public override string EnglishName => "IfcLiteImportFromServer";

        protected override Result RunCommand(RhinoDoc doc, RunMode mode)
        {
            try
            {
                var healthOk = CheckHealth();
                if (!healthOk)
                {
                    RhinoApp.WriteLine("IFC server is not reachable at http://127.0.0.1:8080");
                    return Result.Failure;
                }

                string ifcPath = string.Empty;
                var getPathResult = RhinoGet.GetString("Enter full IFC file path", true, ref ifcPath);
                if (getPathResult != Result.Success) return getPathResult;

                if (!File.Exists(ifcPath))
                {
                    RhinoApp.WriteLine("File not found: " + ifcPath);
                    return Result.Failure;
                }

                var parse = ParseIfc(ifcPath);
                if (parse?.Meshes == null || parse.Meshes.Count == 0)
                {
                    RhinoApp.WriteLine("No meshes returned from server.");
                    return Result.Nothing;
                }
                
                var ifcTypeByExpressId = BuildIfcTypeMap(ifcPath);

                int missingTypeCount = 0;
                int missingExpressIdCount = 0;
                foreach (var m in parse.Meshes)
                {
                    if (m.ExpressId == 0) missingExpressIdCount++;
                    var t = ResolveIfcType(m, ifcTypeByExpressId);
                    if (string.IsNullOrWhiteSpace(t)) missingTypeCount++;
                }
                if (missingExpressIdCount > 0)
                {
                    RhinoApp.WriteLine($"Warning: {missingExpressIdCount} meshes missing express_id in server payload.");
                }
                if (missingTypeCount > 0)
                {
                    RhinoApp.WriteLine($"Warning: {missingTypeCount} meshes missing IFC type; they will be placed on IfcUnknown.");
                }

                int added = 0;
                var layerCache = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
                foreach (var src in parse.Meshes)
                {
                    var mesh = ToRhinoMesh(src);
                    if (mesh == null || !mesh.IsValid) continue;

                    var ifcType = ResolveIfcType(src, ifcTypeByExpressId);
                    if (string.IsNullOrWhiteSpace(ifcType))
                    {
                        ifcType = "IfcUnknown";
                    }
                    var layerIndex = GetOrCreateLayer(doc, ifcType, src.Color, layerCache);

                    var attr = new ObjectAttributes
                    {
                        LayerIndex = layerIndex,
                        ColorSource = ObjectColorSource.ColorFromLayer
                    };

                    if (doc.Objects.AddMesh(mesh, attr) != Guid.Empty) added++;
                }

                doc.Views.Redraw();
                RhinoApp.WriteLine($"Imported {added} mesh objects from IFC.");
                return Result.Success;
            }
            catch (Exception ex)
            {
                RhinoApp.WriteLine("Import failed: " + ex.Message);
                return Result.Failure;
            }
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
            using var http = new HttpClient { BaseAddress = new Uri("http://127.0.0.1:8080") };
            using var form = new MultipartFormDataContent();
            using var fs = File.OpenRead(ifcPath);

            form.Add(new StreamContent(fs), "file", Path.GetFileName(ifcPath));

            using var res = http.PostAsync("/api/v1/parse", form).GetAwaiter().GetResult();
            res.EnsureSuccessStatusCode();

            var json = res.Content.ReadAsStringAsync().GetAwaiter().GetResult();
            return JsonSerializer.Deserialize<ParseResponse>(json, new JsonSerializerOptions
            {
                PropertyNameCaseInsensitive = true
            });
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

        private static Dictionary<uint, string> BuildIfcTypeMap(string ifcPath)
        {
            var map = new Dictionary<uint, string>();

            foreach (var rawLine in File.ReadLines(ifcPath))
            {
                if (string.IsNullOrWhiteSpace(rawLine)) continue;

                var line = rawLine.AsSpan().TrimStart();
                if (line.Length < 4 || line[0] != '#') continue;

                int i = 1;
                uint id = 0;
                bool hasDigit = false;
                while (i < line.Length && char.IsDigit(line[i]))
                {
                    hasDigit = true;
                    id = checked(id * 10 + (uint)(line[i] - '0'));
                    i++;
                }
                if (!hasDigit) continue;

                while (i < line.Length && char.IsWhiteSpace(line[i])) i++;
                if (i >= line.Length || line[i] != '=') continue;
                i++;

                while (i < line.Length && char.IsWhiteSpace(line[i])) i++;
                if (i >= line.Length) continue;

                int typeStart = i;
                while (i < line.Length && (char.IsLetterOrDigit(line[i]) || line[i] == '_')) i++;
                if (i <= typeStart) continue;

                var rawType = line.Slice(typeStart, i - typeStart).ToString();
                var normalized = NormalizeIfcTypeName(rawType);
                if (!string.IsNullOrWhiteSpace(normalized))
                {
                    map[id] = normalized;
                }
            }

            return map;
        }

        private static string ResolveIfcType(MeshDto mesh, Dictionary<uint, string> typeMap)
        {
            if (!string.IsNullOrWhiteSpace(mesh.IfcType))
            {
                return mesh.IfcType.Trim();
            }

            if (mesh.ExpressId != 0 && typeMap.TryGetValue(mesh.ExpressId, out var typeName))
            {
                return typeName;
            }

            return string.Empty;
        }

        private static string NormalizeIfcTypeName(string rawType)
        {
            if (string.IsNullOrWhiteSpace(rawType))
            {
                return string.Empty;
            }

            return rawType.Trim();
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
        [JsonPropertyName("express_id")]
        public uint ExpressId { get; set; }

        [JsonPropertyName("expressId")]
        public uint ExpressIdCamel
        {
            get => ExpressId;
            set => ExpressId = value;
        }

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
