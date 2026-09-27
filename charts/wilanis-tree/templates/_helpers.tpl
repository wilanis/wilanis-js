{{/*
The tree's name, which every object is named after. The values the tool writes always carry it.
*/}}
{{- define "wilanis-tree.name" -}}
{{- required "name is required: install with the values wilanis-deploy writes, -f <root>/deploy/values.yaml" .Values.name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
One workload's objects' name: the tree's, and the profile's where it has one. Called with (dict "root" $ "workload" .).
*/}}
{{- define "wilanis-tree.workload" -}}
{{- $name := include "wilanis-tree.name" .root -}}
{{- if .workload.profile -}}
{{- printf "%s-%s" $name .workload.profile | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name -}}
{{- end -}}
{{- end -}}

{{/*
What selects one workload's pods: the tree, the release, and the profile. Called as wilanis-tree.workload is.
*/}}
{{- define "wilanis-tree.selector" -}}
app.kubernetes.io/name: {{ include "wilanis-tree.name" .root | quote }}
app.kubernetes.io/instance: {{ .root.Release.Name | quote }}
app.kubernetes.io/component: {{ .workload.profile | quote }}
{{- end -}}

{{/*
Every label an object of one workload carries: what selects it, and who made it.
*/}}
{{- define "wilanis-tree.labels" -}}
{{ include "wilanis-tree.selector" . }}
{{- with .root.Values.image.tag }}
app.kubernetes.io/version: {{ . | trunc 63 | trimSuffix "-" | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .root.Release.Service | quote }}
helm.sh/chart: {{ printf "%s-%s" .root.Chart.Name .root.Chart.Version | quote }}
{{- end -}}

{{/*
The Secret every variable is read from: the one the operator names, else the one named after the tree.
*/}}
{{- define "wilanis-tree.secret" -}}
{{- if and .Values.secret.create .Values.secret.existingSecret -}}
{{- fail "secret.create makes the Secret <name>, and secret.existingSecret names one the chart does not make: set one of them" -}}
{{- end -}}
{{- .Values.secret.existingSecret | default (include "wilanis-tree.name" .) -}}
{{- end -}}

{{/*
The PostgreSQL cluster's name, and so the prefix of the Secret its operator writes, <cluster>-app.
*/}}
{{- define "wilanis-tree.postgresql" -}}
{{- printf "%s-postgresql" (include "wilanis-tree.name" .) | trunc 50 | trimSuffix "-" -}}
{{- end -}}

{{/*
The variables the PostgreSQL cluster answers, where it is on: read from its Secret rather than the tree's.
*/}}
{{- define "wilanis-tree.wired" -}}
{{- if .Values.postgresql.enabled -}}
{{- toJson (.Values.postgresql.variables | default list) -}}
{{- else -}}
[]
{{- end -}}
{{- end -}}

{{/*
The image every workload runs: the repository, and the tag where there is one.
*/}}
{{- define "wilanis-tree.image" -}}
{{- $repository := required "image.repository is required: the image the image target's Dockerfile builds" .Values.image.repository -}}
{{- if .Values.image.tag -}}
{{- printf "%s:%s" $repository .Values.image.tag -}}
{{- else -}}
{{- $repository -}}
{{- end -}}
{{- end -}}
