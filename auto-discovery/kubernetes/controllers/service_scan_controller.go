// SPDX-FileCopyrightText: 2021 iteratec GmbH
//
// SPDX-License-Identifier: Apache-2.0

package controllers

import (
	"bytes"
	"context"
	"fmt"
	"regexp"
	"strings"
	"text/template"
	"time"

	"github.com/Masterminds/sprig"
	"github.com/go-logr/logr"
	configv1 "github.com/secureCodeBox/secureCodeBox/auto-discovery/kubernetes/api/v1"
	"github.com/secureCodeBox/secureCodeBox/auto-discovery/kubernetes/pkg/util"
	executionv1 "github.com/secureCodeBox/secureCodeBox/operator/apis/execution/v1"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/errors"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/tools/record"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

// ServiceScanReconciler reconciles a Service object
type ServiceScanReconciler struct {
	client.Client
	Log      logr.Logger
	Scheme   *runtime.Scheme
	Recorder record.EventRecorder
	Config   configv1.AutoDiscoveryConfig
}

const requeueInterval = 5 * time.Second

// +kubebuilder:rbac:groups="execution.securecodebox.io",resources=scantypes,verbs=get;list;watch
// +kubebuilder:rbac:groups="execution.securecodebox.io",resources=scheduledscans,verbs=get;list;watch;create;update;patch
// +kubebuilder:rbac:groups="execution.securecodebox.io/status",resources=scheduledscans,verbs=get;update;patch
// +kubebuilder:rbac:groups="",resources=services,verbs=get;list;watch
// +kubebuilder:rbac:groups="",resources=services/status,verbs=get
// +kubebuilder:rbac:groups="",resources=pods,verbs=get;list;watch
// +kubebuilder:rbac:groups="",resources=namespaces,verbs=get;list;watch
// +kubebuilder:rbac:groups="",resources=pods/status,verbs=get

// Reconcile compares the Service object against the state of the cluster and updates both if needed
func (r *ServiceScanReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	log := r.Log

	log.V(8).Info("Something happened to a service", "service", req.Name, "namespace", req.Namespace)

	// fetch service
	var service corev1.Service
	if err := r.Get(ctx, req.NamespacedName, &service); err != nil {
		log.V(7).Info("Unable to fetch Service", "service", service.Name, "namespace", service.Namespace)
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}

	// fetch namespace
	var namespace corev1.Namespace
	if err := r.Get(ctx, types.NamespacedName{Name: service.Namespace, Namespace: ""}, &namespace); err != nil {
		log.V(7).Info("Unable to fetch namespace for service", "service", service.Name, "namespace", service.Namespace)
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}

	log.V(8).Info("Got Service", "service", service.Name, "namespace", service.Namespace, "resourceVersion", service.ResourceVersion)

	// Checking if the service got likely something to do with http...
	if len(getLikelyHTTPPorts(service)) == 0 {
		log.V(6).Info("Services doesn't seem to have a http / https port", "service", service.Name, "namespace", service.Namespace)
		// No port which has likely to do anything with http. No need to schedule a requeue until the service gets updated
		return ctrl.Result{}, nil
	}

	// get pods matching service label selector
	var pods corev1.PodList
	r.List(ctx, &pods, client.MatchingLabels(service.Spec.Selector), client.InNamespace(service.Namespace))

	// Ensure that pods for the service are in the same version so that the scan scans the correct version
	podDigests := gatherPodDigests(&pods)
	if !containerDigestsAllMatch(podDigests) {
		// Pods for Service don't all have the same digest.
		// Probably currently updating. Checking again in a few seconds.
		log.V(6).Info("Services Pods Digests don't all match. Deployment is probably currently under way. Waiting for it to finish.", "service", service.Name, "namespace", service.Namespace)
		return ctrl.Result{
			Requeue:      true,
			RequeueAfter: requeueInterval,
		}, nil
	}

	// Ensure that at least one pod of the service is ready
	if !serviceHasReadyPods(pods) {
		log.V(6).Info("Service doesn't have any ready pods. Waiting", "service", service.Name, "namespace", service.Namespace)
		return ctrl.Result{
			Requeue:      true,
			RequeueAfter: requeueInterval,
		}, nil
	}

	for _, host := range getHostPorts(service) {
		// Checking if we already have run a scan against this version
		var scans executionv1.ScheduledScanList

		// construct a map of labels which can be used to lookup the scheduledScan created for this service
		versionedLabels := map[string]string{
			"auto-discovery.securecodebox.io/target-service": service.Name,
			"auto-discovery.securecodebox.io/target-port":    fmt.Sprintf("%d", host.Port),
		}
		for containerName, podDigest := range podDigests {
			// The map should only contain one entry at this point. As the reconciler breaks (see containerDigestsAllMatch) if the services points to a list pods with different digests per container name
			for digest := range podDigest {
				versionedLabels[fmt.Sprintf("digest.auto-discovery.securecodebox.io/%s", containerName)] = digest[0:min(len(digest), 63)]
				break
			}
		}

		r.Client.List(ctx, &scans, client.MatchingLabels(versionedLabels), client.InNamespace(service.Namespace))
		log.V(8).Info("Got ScheduledScans for Service in the exact same version", "scheduledScans", len(scans.Items), "service", service.Name, "namespace", service.Namespace)

		if len(scans.Items) != 0 {
			log.V(8).Info("Service Version was already scanned. Skipping.", "service", service.Name, "namespace", service.Namespace)
			continue
		}

		var previousScan executionv1.ScheduledScan
		err := r.Client.Get(ctx, types.NamespacedName{Name: fmt.Sprintf("%s-service-port-%d", service.Name, host.Port), Namespace: service.Namespace}, &previousScan)

		if apierrors.IsNotFound(err) {
			// service was never scanned
			log.Info("Discovered new unscanned service, scanning it now", "service", service.Name, "namespace", service.Namespace)

			// No scan for this pod digest yet. Scanning now
			scan := executionv1.ScheduledScan{
				ObjectMeta: metav1.ObjectMeta{
					Name:        fmt.Sprintf("%s-service-port-%d", service.Name, host.Port),
					Namespace:   service.Namespace,
					Labels:      versionedLabels,
					Annotations: generateScanAnnotations(r.Config.ServiceAutoDiscoveryConfig.ScanConfig, r.Config.Cluster, service, namespace),
				},
				Spec: generateScanSpec(r.Config, r.Config.ServiceAutoDiscoveryConfig.ScanConfig, host, service, namespace),
			}

			scanTypeName := r.Config.ServiceAutoDiscoveryConfig.ScanConfig.ScanType
			scanType := executionv1.ScanType{}

			// Ensure ScanType actually exists
			err := r.Get(ctx, types.NamespacedName{Name: scanTypeName, Namespace: service.Namespace}, &scanType)
			if errors.IsNotFound(err) {
				log.Info("Namespace requires ScanType '"+scanTypeName+"' to properly start automatic scans.", "namespace", service.Namespace, "service", service.Name)
				// Add event to service to communicate failure to user
				r.Recorder.Event(&service, "Warning", "ScanTypeMissing", "Namespace requires ScanType '"+scanTypeName+"' to properly start automatic scans.")

				// Requeue to allow scan to be created when the user installs the scanType
				return ctrl.Result{
					Requeue:      true,
					RequeueAfter: r.Config.ServiceAutoDiscoveryConfig.PassiveReconcileInterval.Duration,
				}, nil
			} else if err != nil {
				return ctrl.Result{
					Requeue:      true,
					RequeueAfter: requeueInterval,
				}, err
			}

			err = r.Create(ctx, &scan)
			if err != nil {
				log.Error(err, "Failed to create ScheduledScan", "service", service.Name)
			}
		} else if err != nil {
			log.Error(err, "Failed to lookup ScheduledScan", "service", service.Name, "namespace", service.Namespace)
		} else {
			// Service was scanned before, but for a different version
			log.Info("Previously scanned service was updated. Repeating scan now.", "service", service.Name, "scheduledScan", previousScan.Name, "namespace", service.Namespace)

			previousScan.ObjectMeta.Labels = versionedLabels
			previousScan.ObjectMeta.Annotations = generateScanAnnotations(r.Config.ServiceAutoDiscoveryConfig.ScanConfig, r.Config.Cluster, service, namespace)
			previousScan.Spec = generateScanSpec(r.Config, r.Config.ServiceAutoDiscoveryConfig.ScanConfig, host, service, namespace)

			log.V(8).Info("Updating previousScan Spec")
			err := r.Update(ctx, &previousScan)
			if err != nil {
				log.Error(err, "Failed to update ScheduledScan", "service", service.Name, "namespace", service.Namespace)
				return ctrl.Result{
					Requeue: true,
				}, err
			}
			// create a new faked lastScheduledTime in the past to force the scheduledScan to be repeated immediately
			// past timestamp is calculated by subtracting the repeat Interval and 24 hours to ensure that it will work even when the auto-discovery and scheduledScan controller have a clock skew
			fakedLastSchedule := metav1.Time{Time: time.Now().Add(-r.Config.ServiceAutoDiscoveryConfig.ScanConfig.RepeatInterval.Duration - 24*time.Hour)}
			log.V(8).Info("Setting LastScheduledTime to the past to rescan it now", "PreviousLastScheduleTime", previousScan.Status.LastScheduleTime, "NewLastScheduleTime", fakedLastSchedule)
			previousScan.Status.LastScheduleTime = &fakedLastSchedule
			r.Status().Update(ctx, &previousScan)
			if err != nil {
				log.Error(err, "Failed to create ScheduledScan", "service", service.Name)
				return ctrl.Result{
					Requeue: true,
				}, err
			}
		}
	}

	return ctrl.Result{
		Requeue:      true,
		RequeueAfter: r.Config.ServiceAutoDiscoveryConfig.PassiveReconcileInterval.Duration,
	}, nil
}

type HostPort struct {
	Type string
	Port int32
}

func getHostPorts(service corev1.Service) []HostPort {
	servicePorts := getLikelyHTTPPorts(service)

	httpIshPorts := []HostPort{}

	for _, port := range servicePorts {
		if port.Port == 443 || port.Port == 8443 || port.Name == "https" {
			httpIshPorts = append(httpIshPorts, HostPort{
				Port: port.Port,
				Type: "https",
			})
		} else {
			httpIshPorts = append(httpIshPorts, HostPort{
				Port: port.Port,
				Type: "http",
			})
		}
	}

	return httpIshPorts
}

func getLikelyHTTPPorts(service corev1.Service) []corev1.ServicePort {
	httpIshPorts := []corev1.ServicePort{}

	for _, port := range service.Spec.Ports {
		if port.Port == 80 ||
			port.Port == 8080 ||
			port.Port == 443 ||
			port.Port == 8443 ||
			// Node.js
			port.Port == 3000 ||
			// Flask
			port.Port == 5000 ||
			// Django
			port.Port == 8000 ||
			// Named Ports
			port.Name == "http" ||
			port.Name == "https" {
			httpIshPorts = append(httpIshPorts, port)
		}
	}

	return httpIshPorts
}

func min(x, y int) int {
	if x < y {
		return x
	}
	return y
}

func getShaHashesForPod(pod corev1.Pod) map[string]string {
	if len(pod.Status.ContainerStatuses) == 0 {
		return nil
	}

	hashes := map[string]string{}

	for _, containerStatus := range pod.Status.ContainerStatuses {
		if containerStatus.ImageID == "" {
			continue
		}

		var fullImageName string
		if strings.HasPrefix(containerStatus.ImageID, "docker-pullable://") {
			// Extract the fullImageName from the following format "docker-pullable://scbexperimental/parser-nmap@sha256:f953..."
			fullImageName = containerStatus.ImageID[18:]
		} else {
			continue
		}

		imageSegments := strings.Split(fullImageName, "@")
		prefixedDigest := imageSegments[1]

		var truncatedDigest string
		if strings.HasPrefix(prefixedDigest, "sha256:") {
			// Only keep actual digest
			// Example from "sha256:f953bc6c5446c20ace8787a1956c2e46a2556cc7a37ef7fc0dda7b11dd87f73d"
			// What is kept: "f953bc6c5446c20ace8787a1956c2e46a2556cc7a37ef7fc0dda7b11dd87f73d"
			truncatedDigest = prefixedDigest[7:71]
			hashes[containerStatus.Name] = truncatedDigest
		}
	}

	return hashes
}

// Takes a list of pods and returns a two tiered map to lookup pod digests per container
// The map returned look like this:
// {
// 	// container name
// 	container1: {
// 		// digest
// 		ab2dkbsjdha3kshdasjdbalsjdbaljsbd: true
// 		iuzaksbd2kabsdk4abksdbaksjbdak12a: true
// 	},
// 	container2: {
// 		// digest
// 		sjdha3kshdasjdbalsjdbaljsbdab2dkb: true
// 		d2kabsdk4abksdbaksjbdak12aiuzaksb: true
// 	},
// }
func gatherPodDigests(pods *corev1.PodList) map[string]map[string]bool {
	podDigests := map[string]map[string]bool{}

	for _, pod := range pods.Items {
		hashes := getShaHashesForPod(pod)

		for containerName, hash := range hashes {
			if _, ok := podDigests[containerName]; ok {
				podDigests[containerName][hash] = true
			} else {
				podDigests[containerName] = map[string]bool{hash: true}
			}
		}
	}

	return podDigests
}

func containerDigestsAllMatch(podDigests map[string]map[string]bool) bool {
	for _, digests := range podDigests {
		if len(digests) != 1 {
			return false
		}
	}

	return true
}

func serviceHasReadyPods(pods corev1.PodList) bool {
podLoop:
	for _, pod := range pods.Items {
		for _, containerStatus := range pod.Status.ContainerStatuses {
			if containerStatus.Ready == false {
				continue podLoop
			}
		}
		return true
	}
	return false
}

func generateScanAnnotations(scanConfig configv1.ScanConfig, clusterConfig configv1.ClusterConfig, service corev1.Service, namespace corev1.Namespace) map[string]string {
	annotations := util.RenderAnnotations(scanConfig.Annotations, service.ObjectMeta, namespace.ObjectMeta, clusterConfig.Name)

	// Copy over securecodebox.io annotations to the created scan
	re := regexp.MustCompile(`.*securecodebox\.io/.*`)
	for key, value := range service.Annotations {
		if matches := re.MatchString(key); matches {
			annotations[key] = value
		}
	}
	return annotations

}

type TemplateArgs struct {
	Config     configv1.AutoDiscoveryConfig
	ScanConfig configv1.ScanConfig
	Service    corev1.Service
	Namespace  corev1.Namespace
	Host       HostPort
}

// Takes in both autoDiscoveryConfig and scanConfig as this function might be used by other controllers in the future, which can then pass in the their relevant scanConfig into this function
func generateScanSpec(autoDiscoveryConfig configv1.AutoDiscoveryConfig, scanConfig configv1.ScanConfig, host HostPort, service corev1.Service, namespace corev1.Namespace) executionv1.ScheduledScanSpec {
	parameters := scanConfig.Parameters

	templateArgs := TemplateArgs{
		Config:    autoDiscoveryConfig,
		Service:   service,
		Namespace: namespace,
		Host:      host,
	}

	params := []string{}

	for i, parameterTemplate := range parameters {
		tmpl, err := template.New(fmt.Sprintf("Annotation Template scan parameter '%d'", i)).Funcs(sprig.TxtFuncMap()).Parse(parameterTemplate)
		if err != nil {
			panic(err)
		}

		var rawOutput bytes.Buffer
		err = tmpl.Execute(&rawOutput, templateArgs)
		output := rawOutput.String()

		// skip empty string values to allow users to skip annotations
		if output != "" {
			params = append(params, output)
		}
	}

	scheduledScanSpec := executionv1.ScheduledScanSpec{
		Interval: scanConfig.RepeatInterval,
		ScanSpec: &executionv1.ScanSpec{
			ScanType:   scanConfig.ScanType,
			Parameters: params,
		},
	}

	return scheduledScanSpec
}

// SetupWithManager sets up the controller and initializes every thing it needs
func (r *ServiceScanReconciler) SetupWithManager(mgr ctrl.Manager) error {
	ctx := context.Background()
	if err := mgr.GetFieldIndexer().IndexField(ctx, &executionv1.ScheduledScan{}, ".metadata.service-controller", func(rawObj client.Object) []string {
		// grab the job object, extract the owner...
		scan := rawObj.(*executionv1.ScheduledScan)
		owner := metav1.GetControllerOf(scan)
		if owner == nil {
			return nil
		}
		// ...make sure it's a Service...
		if owner.APIVersion != "v1" || owner.Kind != "Service" {
			return nil
		}

		// ...and if so, return it
		return []string{owner.Name}
	}); err != nil {
		return err
	}

	return ctrl.NewControllerManagedBy(mgr).
		For(&corev1.Service{}).
		WithEventFilter(getPredicates(mgr.GetClient(), r.Log, r.Config.ResourceInclusion.Mode)).
		Complete(r)
}
