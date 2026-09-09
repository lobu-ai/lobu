{{/*
Expand the name of the chart.
*/}}
{{- define "lobu.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "lobu.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "lobu.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "lobu.labels" -}}
helm.sh/chart: {{ include "lobu.chart" . }}
{{ include "lobu.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "lobu.selectorLabels" -}}
app.kubernetes.io/name: {{ include "lobu.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
App selector labels
*/}}
{{- define "lobu.appSelectorLabels" -}}
{{ include "lobu.selectorLabels" . }}
app.kubernetes.io/component: api
{{- end }}

{{/*
Worker selector labels
*/}}
{{- define "lobu.workerSelectorLabels" -}}
{{ include "lobu.selectorLabels" . }}
app.kubernetes.io/component: worker
{{- end }}

{{/*
Embeddings selector labels
*/}}
{{- define "lobu.embeddingsSelectorLabels" -}}
{{ include "lobu.selectorLabels" . }}
app.kubernetes.io/component: embeddings
{{- end }}

{{/*
Create the app image name
*/}}
{{- define "lobu.appImage" -}}
{{- $tag := .Values.image.tag | default .Chart.AppVersion }}
{{- printf "%s/%s-app:%s" .Values.image.registry .Values.image.repository $tag }}
{{- end }}

{{/*
Create the worker image name
*/}}
{{- define "lobu.workerImage" -}}
{{- $tag := .Values.image.tag | default .Chart.AppVersion }}
{{- printf "%s/%s-worker:%s" .Values.image.registry .Values.image.repository $tag }}
{{- end }}

{{/*
Create the embeddings service image name
*/}}
{{- define "lobu.embeddingsImage" -}}
{{- $tag := .Values.image.tag | default .Chart.AppVersion }}
{{- printf "%s/%s-embeddings:%s" .Values.image.registry .Values.image.repository $tag }}
{{- end }}

{{/* Fail before rendering an app topology that cannot share durable artifacts. */}}
{{- define "lobu.validateArtifactTopology" -}}
{{- $appEnv := default dict .Values.app.env }}
{{/*
Multi-replica with artifact storage DISABLED points every pod at its own
/tmp/lobu-artifacts. The publish and the download are separate requests, so a
download served by a different pod than the publish 404s — intermittently,
which reads as flakiness rather than a topology error. The server cannot catch
this: it only checks that LOBU_ARTIFACTS_DIR is set, and a pod-local /tmp
satisfies that. This is the only place that knows both the replica count and
whether the volume is shared.
*/}}
{{- if and (gt (int .Values.app.replicaCount) 1) (not .Values.app.artifacts.enabled) }}
{{- fail "app.replicaCount > 1 requires app.artifacts.enabled=true: with artifact storage off every replica writes to its own pod-local /tmp, so a download that lands on a different pod than the publish returns 404 intermittently. Enable artifacts with an RWX class, or keep app.replicaCount at 1." }}
{{- end }}
{{- if .Values.app.artifacts.enabled }}
{{- if and (gt (int .Values.app.replicaCount) 1) (ne .Values.app.artifacts.accessMode "ReadWriteMany") }}
{{- fail "app.replicaCount > 1 with app.artifacts.enabled=true requires app.artifacts.accessMode=ReadWriteMany so every replica can read the same durable bytes" }}
{{- end }}
{{- if and (hasKey $appEnv "LOBU_ARTIFACTS_DIR") (ne (get $appEnv "LOBU_ARTIFACTS_DIR") .Values.app.artifacts.mountPath) }}
{{- fail "app.env.LOBU_ARTIFACTS_DIR must equal app.artifacts.mountPath when artifact storage is enabled" }}
{{- end }}
{{- end }}
{{- end }}
