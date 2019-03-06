import React from 'react';
import './Home.css';

const Home = ({ trigger }) => {
  return (
    <div id="home" class="container">
      <h3 id="u1">Welcome To fl<span id="u11">ai</span> Downloads</h3>
      <div class="row">
        <div class="col-12" align="center">
          <form method="post" action="https://flai-api.herokuapp.com/download" >
            <div class="form-group">
              <input type="text" name="user[url]" required class="form-control" placeholder="Downloadable URL" id="u2" />
              <input type="password" name="user[password]" required class="form-control" placeholder="Password" id="u3" />
              <input list="extension" name="user[extension]" required class="extension" placeholder="Extension" id="u4" />
              <datalist id="extension" >
                <option value=".zip">.zip</option>
                <option value=".mp4">.mp4</option>
                <option value=".mkv">.mkv</option>
                <option value=".mp3">.mp3</option>
              </datalist>
              <button type="submit" class="btn btn-danger">Download</button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

export default Home;