function toggleMenu() {
    const menu = document.querySelector(".menu-links");
    const icon = document.querySelector(".hamburger-icon");
    menu.classList.toggle("open")
    icon.classList.toggle("open")
}

// Get the modal
var modal = document.getElementById("projectModal");

// Get the button that opens the modal
var btn = document.getElementsByClassName("project-block");

// Get the <span> element that closes the modal
var span = document.getElementsByClassName("close")[0];

// Function to open the modal and display project details
function showProjectDetails(projectId) {
    var modal = document.getElementById("projectModal");
    modal.style.display = "block";
  
    // Hide all project details
    var projectDetails = document.querySelectorAll(".project-details");
    projectDetails.forEach(function(item) {
      item.style.display = "none";
    });
  
    // Display the project details corresponding to the clicked project block
    var projectDetailsToShow = document.getElementById(projectId + "-details");
    projectDetailsToShow.style.display = "block";
}

// Function to close the modal
function closeProjectDetails() {
  modal.style.display = "none";
}

// Close the modal when the user clicks anywhere outside of the modal
window.onclick = function(event) {
  if (event.target == modal) {
    modal.style.display = "none";
  }
}

// Get the audio element
var audio = document.getElementById("myaudio");

// Check if the audio is playing
if (audio.paused) {
    // If paused, play the audio
    audio.play();
}
